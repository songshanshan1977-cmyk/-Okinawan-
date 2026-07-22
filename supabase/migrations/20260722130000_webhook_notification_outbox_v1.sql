-- 20260722130000_webhook_notification_outbox_v1.sql
--
-- DRAFT — sandbox/webhook-fail-safe-v1. NOT applied to production.
-- Added in the Codex Draft-PR-#2 blocking-fix round to address B-03/B-04:
-- a recoverable, provider-agnostic notification outbox on public.send_logs,
-- replacing orders.email_customer_sent/email_ops_sent as the source of
-- truth for "does this webhook still need to send an email". Those two
-- booleans could not simultaneously represent: success vs pending-manual-
-- review content, a second conflicting Session's own independent
-- notification, an in-flight send claim, and final delivery — one boolean
-- per audience cannot encode five states.
--
-- MUST be applied AFTER 20260722120000_webhook_fail_safe_v1.sql, which
-- inserts into the columns this file adds.
--
-- DB INTEGRATION UNVERIFIED — see the header of the prior migration file;
-- the same caveats apply here (no live schema re-confirmation, no local
-- Postgres available to execute this against).

-- =============================================================
-- 1. send_logs outbox columns
-- =============================================================
-- Existing columns per the schema captured in earlier rounds: id,
-- order_id, email, subject, status (default 'pending'), error_message,
-- created_at, provider_message_id. Nothing currently writes to this table
-- (confirmed by repo-wide grep in the round-8 audit), so these additions
-- are pure extension, not a behavior change for any existing writer.
ALTER TABLE public.send_logs ADD COLUMN IF NOT EXISTS dedupe_key text;
ALTER TABLE public.send_logs ADD COLUMN IF NOT EXISTS notification_type text;
ALTER TABLE public.send_logs ADD COLUMN IF NOT EXISTS audience text;
ALTER TABLE public.send_logs ADD COLUMN IF NOT EXISTS stripe_session_id text;
ALTER TABLE public.send_logs ADD COLUMN IF NOT EXISTS claim_token uuid;
ALTER TABLE public.send_logs ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;
ALTER TABLE public.send_logs ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.send_logs ADD COLUMN IF NOT EXISTS sent_at timestamptz;
ALTER TABLE public.send_logs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
-- provider_message_id and error_message are reused as-is (already exist).

-- dedupe_key = order_id || ':' || stripe_session_id || ':' || audience ||
-- ':' || notification_type — guarantees at most one outbox row per
-- (order, Session, audience, notification variant), which is exactly what
-- lets process_checkout_payment_v1 insert it with ON CONFLICT (dedupe_key)
-- DO NOTHING and be safe against being called twice for the same Session.
--
-- Plain (non-partial) unique index: PostgreSQL unique indexes already
-- treat every NULL as distinct from every other NULL, so pre-existing rows
-- with no dedupe_key (if any ever existed) are unaffected, and this index
-- can be used directly as an ON CONFLICT (dedupe_key) inference target
-- without needing a matching partial-index predicate in the INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS send_logs_dedupe_key_unique_idx
  ON public.send_logs (dedupe_key);

CREATE INDEX IF NOT EXISTS send_logs_claimable_idx
  ON public.send_logs (order_id, stripe_session_id, status);

-- =============================================================
-- 2. claim_webhook_notification_v1 — claim claimable outbox rows
-- =============================================================
-- Claims every send_logs row for (p_order_id, p_stripe_session_id) that is
-- pending, failed, or stuck in "processing" past its claim_expires_at
-- (i.e. a prior process died between claiming and completing). Each
-- claimed row gets a fresh, single-use claim_token and a short claim
-- lease; the caller must present that exact token back to
-- complete_webhook_notification_v1 or the claim is worthless.
--
-- Returns only routing metadata — dedupe_key/notification_type/audience/
-- claim_token/order_id — never email/subject/customer PII, so a caller
-- that only needs to know "what do I need to send" doesn't also receive
-- content it didn't ask for. The webhook still does its own separate
-- `orders` select to build the actual email body, exactly as before.
CREATE OR REPLACE FUNCTION public.claim_webhook_notification_v1(
  p_order_id text,
  p_stripe_session_id text
)
RETURNS TABLE (
  dedupe_key text,
  notification_type text,
  audience text,
  claim_token uuid,
  order_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  r RECORD;
  v_token uuid;
BEGIN
  IF p_order_id IS NULL OR length(trim(p_order_id)) = 0
     OR p_stripe_session_id IS NULL OR length(trim(p_stripe_session_id)) = 0 THEN
    RAISE EXCEPTION 'claim_webhook_notification_v1: p_order_id and p_stripe_session_id are required'
      USING ERRCODE = 'P0004';
  END IF;

  FOR r IN
    SELECT sl.id, sl.dedupe_key, sl.notification_type, sl.audience
    FROM public.send_logs sl
    WHERE sl.order_id = p_order_id
      AND sl.stripe_session_id = p_stripe_session_id
      AND (
        sl.status = 'pending'
        OR sl.status = 'failed'
        OR (sl.status = 'processing' AND sl.claim_expires_at IS NOT NULL AND sl.claim_expires_at < now())
      )
    FOR UPDATE SKIP LOCKED
  LOOP
    v_token := gen_random_uuid();

    UPDATE public.send_logs
    SET status = 'processing',
        claim_token = v_token,
        claim_expires_at = now() + interval '2 minutes',
        attempt_count = attempt_count + 1,
        updated_at = now()
    WHERE id = r.id;

    dedupe_key := r.dedupe_key;
    notification_type := r.notification_type;
    audience := r.audience;
    claim_token := v_token;
    order_id := p_order_id;
    RETURN NEXT;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_webhook_notification_v1(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_webhook_notification_v1(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.claim_webhook_notification_v1(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_webhook_notification_v1(text, text) TO service_role;

-- =============================================================
-- 3. complete_webhook_notification_v1 — finish a claimed outbox row
-- =============================================================
-- Only succeeds if the caller presents the SAME claim_token that
-- claim_webhook_notification_v1 handed out for this dedupe_key — this is
-- what makes it safe for two overlapping webhook deliveries to both call
-- claim (the second one only picks up rows the first one's claim has
-- since expired) without ever completing the same physical send twice
-- under each other's authority.
--
-- On success: status='sent', sent_at, provider_message_id recorded, claim
-- fields cleared. On failure: status='failed' (claimable again by a later
-- retry), error_message stored TRUNCATED (never raw provider payloads or
-- secrets), claim fields cleared.
CREATE OR REPLACE FUNCTION public.complete_webhook_notification_v1(
  p_dedupe_key text,
  p_claim_token uuid,
  p_success boolean,
  p_provider_message_id text DEFAULT NULL,
  p_error_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_updated integer;
BEGIN
  IF p_dedupe_key IS NULL OR p_claim_token IS NULL THEN
    RAISE EXCEPTION 'complete_webhook_notification_v1: p_dedupe_key and p_claim_token are required'
      USING ERRCODE = 'P0005';
  END IF;

  IF p_success THEN
    UPDATE public.send_logs
    SET status = 'sent',
        sent_at = now(),
        provider_message_id = p_provider_message_id,
        claim_token = NULL,
        claim_expires_at = NULL,
        error_message = NULL,
        updated_at = now()
    WHERE dedupe_key = p_dedupe_key
      AND claim_token = p_claim_token;
  ELSE
    UPDATE public.send_logs
    SET status = 'failed',
        -- Never persist a raw provider payload or secret — truncate hard.
        error_message = left(coalesce(p_error_message, 'unknown_error'), 500),
        claim_token = NULL,
        claim_expires_at = NULL,
        updated_at = now()
    WHERE dedupe_key = p_dedupe_key
      AND claim_token = p_claim_token;
  END IF;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    -- Claim token didn't match anything claimable right now — either it
    -- already expired and got re-claimed by someone else, or it was
    -- already completed. The caller must NOT treat this as "I completed
    -- it" or re-attempt sending under the assumption it still owns it.
    RETURN jsonb_build_object('ok', false, 'reason', 'claim_token_mismatch_or_expired');
  END IF;

  -- Backward-compat: keep the legacy orders.email_customer_sent /
  -- email_ops_sent booleans in sync on real success, for any existing
  -- back-office code that still reads them — but per B-03/B-04 they are
  -- NOT read by this outbox's own claim logic, only written as a mirror.
  IF p_success THEN
    UPDATE public.orders o
    SET email_customer_sent = true
    FROM public.send_logs sl
    WHERE sl.dedupe_key = p_dedupe_key
      AND o.order_id = sl.order_id
      AND sl.notification_type IN ('customer_booking_confirmed', 'customer_manual_review');

    UPDATE public.orders o
    SET email_ops_sent = true
    FROM public.send_logs sl
    WHERE sl.dedupe_key = p_dedupe_key
      AND o.order_id = sl.order_id
      AND sl.notification_type IN ('ops_booking_confirmed', 'ops_manual_review');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_webhook_notification_v1(text, uuid, boolean, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_webhook_notification_v1(text, uuid, boolean, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.complete_webhook_notification_v1(text, uuid, boolean, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_webhook_notification_v1(text, uuid, boolean, text, text) TO service_role;

-- Explicitly NOT modified: public.lock_inventory_v2 stays exactly as-is.
-- Explicitly NOT created: any webhook_events table.
