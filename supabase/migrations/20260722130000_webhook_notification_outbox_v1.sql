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
-- Revised again in the second Codex review round (R2) to add:
--   - a frozen payload (recipient_email/email_subject/email_html) so a
--     retry after a Resend-provider-Idempotency-Key-covered send always
--     resends byte-identical content, never re-derived from
--     possibly-changed `orders` data (§三 of the R2 fix instructions);
--   - a 23-hour dead-letter cutoff matching Resend's own Idempotency-Key
--     validity window, so nothing auto-retries a customer email forever
--     (§四);
--   - complete_webhook_notification_v1's boolean p_success replaced with a
--     3-way p_outcome ('sent' | 'failed' | 'dead_letter'), so Node can
--     directly dead-letter a deterministically-undeliverable row (e.g. no
--     customer email on file) without waiting out the 23-hour window
--     (§五).
--
-- Revised a third time (R3) to address the last 3 blocking findings:
--   - the frozen payload now covers the SENDER address and the
--     provider-facing Idempotency-Key too, not just the recipient side —
--     R2 left a gap where the same Resend Idempotency-Key could be
--     replayed with a different `from` if RESEND_FROM changed between
--     attempts (§一/§二);
--   - a customer row dead-lettering specifically for a missing email now
--     atomically creates its own dedicated ops_missing_customer_email
--     alert row — previously operations only ever saw the ordinary
--     business-outcome email, with no independent signal that the
--     customer's own copy never went out (§三);
--   - the hardcoded operations-email fallback is gone from the Node code
--     this migration's RPCs serve; a missing NOTIFY_TO_EMAIL now fails
--     closed at the application layer rather than silently substituting a
--     baked-in address (§四, enforced in pages/api/stripe-webhook.js, not
--     in this SQL file).
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
-- outside this webhook's own outbox usage (confirmed by repo-wide grep),
-- so these additions are pure extension.
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

-- R2 §三 / R3 §一: the frozen payload. Written exactly once per row (by
-- freeze_webhook_notification_payload_v1, first-writer-wins) so every
-- retry — including ones using the SAME Resend Idempotency-Key — sends a
-- byte-identical request, never content re-derived from `orders` data (or
-- from the RESEND_FROM environment variable) that may have changed
-- between attempts. R3 extends this to the SENDER address and the
-- provider-facing idempotency key itself — R2 only froze the recipient
-- side, which left the door open for the same Idempotency-Key to be
-- replayed with a different `from` if RESEND_FROM changed between
-- attempts.
ALTER TABLE public.send_logs ADD COLUMN IF NOT EXISTS sender_email text;
ALTER TABLE public.send_logs ADD COLUMN IF NOT EXISTS recipient_email text;
ALTER TABLE public.send_logs ADD COLUMN IF NOT EXISTS email_subject text;
ALTER TABLE public.send_logs ADD COLUMN IF NOT EXISTS email_html text;
-- R3 §二: the provider-facing Idempotency-Key Node computes as
-- `webhook-` + sha256(dedupe_key) — never the raw dedupe_key itself (which
-- embeds the order_id/session_id/audience/notification_type in the clear).
-- Frozen alongside the rest of the payload on first freeze; every retry
-- reads this back rather than recomputing it, so "same key, same content"
-- holds even though the computation is deterministic and recomputing it
-- would happen to produce the same value anyway — reading the frozen
-- value keeps a single, auditable source of truth for what was actually
-- sent to the provider.
ALTER TABLE public.send_logs ADD COLUMN IF NOT EXISTS provider_idempotency_key text;
ALTER TABLE public.send_logs ADD COLUMN IF NOT EXISTS payload_frozen_at timestamptz;

-- R2 §四: the moment a claim first picks up this row for real dispatch
-- (set by claim_webhook_notification_v1 the first time it claims a row
-- whose first_dispatch_at is still NULL). This marks when the row entered
-- the SEND pipeline — it does NOT mean Resend received or acknowledged
-- any request; the actual attempt could still fail before, during, or
-- after the provider call. Anchors the 23-hour automatic-retry cutoff,
-- deliberately ONE HOUR inside Resend's documented 24-hour Idempotency-Key
-- validity window.
ALTER TABLE public.send_logs ADD COLUMN IF NOT EXISTS first_dispatch_at timestamptz;

-- dedupe_key composition varies by notification family (see the core
-- migration's INSERT statements for the exact per-branch format), but is
-- always built so that: (a) retries of the exact same terminal outcome
-- reuse the identical key, and (b) two conceptually different
-- notifications (different order/session/audience/notification_type, or —
-- for the session/order-conflict alert — different attempted order_id)
-- always get different keys.
--
-- Plain (non-partial) unique index: PostgreSQL unique indexes already
-- treat every NULL as distinct from every other NULL, so this index can be
-- used directly as an ON CONFLICT (dedupe_key) inference target.
CREATE UNIQUE INDEX IF NOT EXISTS send_logs_dedupe_key_unique_idx
  ON public.send_logs (dedupe_key);

CREATE INDEX IF NOT EXISTS send_logs_claimable_idx
  ON public.send_logs (order_id, stripe_session_id, status);

-- =============================================================
-- 2. claim_webhook_notification_v1 — claim claimable outbox rows
-- =============================================================
-- Two responsibilities, in order:
--   (a) sweep: any row for THIS (order_id, stripe_session_id) that is
--       still un-sent and has been "dispatching" for >= 23 hours since its
--       first_dispatch_at is moved to status='dead_letter' — it will never
--       be selected as claimable again by this or any future call, and
--       Resend's own Idempotency-Key for it will itself have expired
--       server-side by the time anyone could act on it anyway.
--   (b) claim: of what's left, claim every row that is pending, failed, or
--       stuck in "processing" past its claim_expires_at (i.e. a prior
--       process died between claiming and completing). Each claimed row
--       gets a fresh, single-use claim_token and a short claim lease; on a
--       row's FIRST ever claim (first_dispatch_at IS NULL) that moment is
--       recorded as first_dispatch_at.
--
-- Returns only routing metadata — dedupe_key/notification_type/audience/
-- claim_token/order_id — never email/subject/customer PII. The frozen
-- payload (if any) is fetched separately via
-- freeze_webhook_notification_payload_v1, which is also where a
-- not-yet-frozen row gets its content written for the first time.
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

  -- (a) 23-hour dead-letter sweep — see the function-level comment above.
  -- 'provider_delivery_uncertain' means exactly that and nothing more:
  -- this pipeline can no longer confirm one way or the other whether
  -- Resend ever received or sent this specific email — NOT "Resend never
  -- got it" and NOT "Resend definitely sent it". After this point nothing
  -- in this codebase acts on the row again; a human (via direct DB query —
  -- no admin/monitoring surface for this was built this round) has to
  -- decide what, if anything, to do about it.
  UPDATE public.send_logs
  SET status = 'dead_letter',
      claim_token = NULL,
      claim_expires_at = NULL,
      error_message = 'provider_delivery_uncertain',
      updated_at = now()
  WHERE order_id = p_order_id
    AND stripe_session_id = p_stripe_session_id
    AND status IN ('pending', 'failed', 'processing')
    AND first_dispatch_at IS NOT NULL
    AND first_dispatch_at <= now() - interval '23 hours';

  -- (b) claim whatever remains claimable.
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
        -- Audit-only counter — NOT a retry limit. Nothing in this codebase
        -- reads attempt_count to decide whether to stop retrying; the
        -- 23-hour first_dispatch_at cutoff above is the only hard stop on
        -- automatic retries.
        attempt_count = attempt_count + 1,
        -- Only ever set on this row's FIRST claim; every later reclaim
        -- (after a crash, an expired lease, or a failed send) leaves the
        -- original moment untouched — that original moment is what the
        -- 23-hour cutoff above is measured from.
        first_dispatch_at = COALESCE(first_dispatch_at, now()),
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
-- 3. freeze_webhook_notification_payload_v1 — first-writer-wins content
-- =============================================================
-- R3 §一/§二: freezes the COMPLETE outbound request, not just the
-- recipient side — sender_email, recipient_email, subject, html, AND the
-- provider_idempotency_key Node computed for this row. R2's version only
-- froze recipient/subject/html, which left a real hazard: the SAME
-- Resend Idempotency-Key could be replayed with a DIFFERENT `from` address
-- if RESEND_FROM changed between attempts (a redeploy, a config change).
-- Freezing the sender and the idempotency key together with the content
-- guarantees "same key -> same complete request" holds unconditionally.
--
-- Called by Node immediately after claiming a row and building a
-- CANDIDATE email from current `orders` data / current env vars. If this
-- row has never been frozen before, the candidate becomes authoritative
-- and is stored. If it HAS already been frozen (a retry, possibly after
-- `orders` data or RESEND_FROM has since changed), the candidate is
-- discarded and the ALREADY-frozen content is returned instead — so the
-- actual bytes sent to Resend, and the Idempotency-Key request, are always
-- self-consistent across every retry of the same outbox row. Node MUST
-- use only the returned `frozen.*` fields for the actual send — never its
-- own freshly-built candidate, even on what it believes is the first
-- attempt (a concurrent delivery could have frozen it moments earlier).
--
-- Only succeeds if p_claim_token matches the row's CURRENT claim_token —
-- exactly the same ownership check as complete_webhook_notification_v1, so
-- a stale/expired claim can never freeze (or read) a payload out from
-- under whoever currently owns the row.
CREATE OR REPLACE FUNCTION public.freeze_webhook_notification_payload_v1(
  p_dedupe_key text,
  p_claim_token uuid,
  p_sender_email text,
  p_recipient_email text,
  p_email_subject text,
  p_email_html text,
  p_provider_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_row public.send_logs%ROWTYPE;
BEGIN
  IF p_dedupe_key IS NULL OR p_claim_token IS NULL THEN
    RAISE EXCEPTION 'freeze_webhook_notification_payload_v1: p_dedupe_key and p_claim_token are required'
      USING ERRCODE = 'P0006';
  END IF;

  -- R3 §一 item 3: every field of a NEW payload must be non-blank. This is
  -- a defense-in-depth guard against a caller bug — Node's own logic
  -- should never reach this call with a blank field (it dead-letters/fails
  -- the row itself first, see pages/api/stripe-webhook.js), but the
  -- database must not silently accept and freeze garbage either.
  IF length(trim(coalesce(p_sender_email, ''))) = 0
     OR length(trim(coalesce(p_recipient_email, ''))) = 0
     OR length(trim(coalesce(p_email_subject, ''))) = 0
     OR length(trim(coalesce(p_email_html, ''))) = 0
     OR length(trim(coalesce(p_provider_idempotency_key, ''))) = 0 THEN
    RAISE EXCEPTION 'freeze_webhook_notification_payload_v1: all payload fields must be non-blank'
      USING ERRCODE = 'P0008';
  END IF;

  SELECT * INTO v_row
  FROM public.send_logs
  WHERE dedupe_key = p_dedupe_key
    AND claim_token = p_claim_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'claim_token_mismatch_or_expired');
  END IF;

  IF v_row.payload_frozen_at IS NULL THEN
    UPDATE public.send_logs
    SET sender_email = p_sender_email,
        recipient_email = p_recipient_email,
        email_subject = p_email_subject,
        email_html = p_email_html,
        provider_idempotency_key = p_provider_idempotency_key,
        payload_frozen_at = now(),
        updated_at = now()
    WHERE dedupe_key = p_dedupe_key
      AND claim_token = p_claim_token
    RETURNING * INTO v_row;
  END IF;
  -- else: already frozen — v_row already holds the existing payload as
  -- read above; the candidate this call was passed is silently discarded.
  -- This is not a log-worthy event: it is the expected, correct outcome
  -- of every retry after the first.

  RETURN jsonb_build_object(
    'ok', true,
    'frozen', jsonb_build_object(
      'from', v_row.sender_email,
      'to', v_row.recipient_email,
      'subject', v_row.email_subject,
      'html', v_row.email_html,
      'provider_idempotency_key', v_row.provider_idempotency_key
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.freeze_webhook_notification_payload_v1(text, uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.freeze_webhook_notification_payload_v1(text, uuid, text, text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.freeze_webhook_notification_payload_v1(text, uuid, text, text, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.freeze_webhook_notification_payload_v1(text, uuid, text, text, text, text, text) TO service_role;

-- =============================================================
-- 4. complete_webhook_notification_v1 — finish a claimed outbox row
-- =============================================================
-- R2: the old boolean p_success is replaced with a 3-way p_outcome, so
-- Node can express a THIRD terminal state — 'dead_letter' — for a row it
-- has determined right now, deterministically, can never be delivered
-- (e.g. the order has no customer email on file at all: retrying will
-- never produce one). This is distinct from the 23-hour sweep in
-- claim_webhook_notification_v1, which dead-letters rows that simply ran
-- out of automatic-retry time; here Node is asserting "there is no point
-- ever retrying this specific row again", immediately.
--
-- Only succeeds if the caller presents the SAME claim_token that
-- claim_webhook_notification_v1 (or freeze_webhook_notification_payload_v1
-- re-reading it) is currently honoring for this dedupe_key.
CREATE OR REPLACE FUNCTION public.complete_webhook_notification_v1(
  p_dedupe_key text,
  p_claim_token uuid,
  p_outcome text,
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
  v_order_id text;
  v_session_id text;
BEGIN
  IF p_dedupe_key IS NULL OR p_claim_token IS NULL THEN
    RAISE EXCEPTION 'complete_webhook_notification_v1: p_dedupe_key and p_claim_token are required'
      USING ERRCODE = 'P0005';
  END IF;

  IF p_outcome NOT IN ('sent', 'failed', 'dead_letter') THEN
    RAISE EXCEPTION 'complete_webhook_notification_v1: invalid p_outcome: %', p_outcome
      USING ERRCODE = 'P0007';
  END IF;

  IF p_outcome = 'sent' THEN
    UPDATE public.send_logs
    SET status = 'sent',
        sent_at = now(),
        provider_message_id = p_provider_message_id,
        claim_token = NULL,
        claim_expires_at = NULL,
        error_message = NULL,
        updated_at = now()
    WHERE dedupe_key = p_dedupe_key
      AND claim_token = p_claim_token
      -- A 'sent' outcome always requires an actual provider message id —
      -- never let a caller mark a row sent with no proof of delivery.
      AND p_provider_message_id IS NOT NULL
      AND length(trim(p_provider_message_id)) > 0;
  ELSIF p_outcome = 'failed' THEN
    UPDATE public.send_logs
    SET status = 'failed',
        -- Never persist a raw provider payload or secret — truncate hard.
        error_message = left(coalesce(p_error_message, 'unknown_error'), 500),
        claim_token = NULL,
        claim_expires_at = NULL,
        updated_at = now()
    WHERE dedupe_key = p_dedupe_key
      AND claim_token = p_claim_token;
  ELSE -- 'dead_letter'
    UPDATE public.send_logs
    SET status = 'dead_letter',
        error_message = left(coalesce(p_error_message, 'manual_action_required'), 500),
        claim_token = NULL,
        claim_expires_at = NULL,
        updated_at = now()
    WHERE dedupe_key = p_dedupe_key
      AND claim_token = p_claim_token;
  END IF;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    -- Claim token didn't match anything claimable right now (already
    -- expired and re-claimed by someone else, already completed, or —
    -- for 'sent' — no usable provider_message_id was supplied). The
    -- caller must NOT treat this as "I completed it".
    RETURN jsonb_build_object('ok', false, 'reason', 'claim_token_mismatch_or_expired');
  END IF;

  -- Backward-compat: keep the legacy orders.email_customer_sent /
  -- email_ops_sent booleans in sync on real delivery success ONLY — never
  -- on 'failed' or 'dead_letter'. Per B-03/B-04 these are a write-only
  -- mirror for back-office code; nothing in this outbox reads them.
  IF p_outcome = 'sent' THEN
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
      AND sl.notification_type IN ('ops_booking_confirmed', 'ops_manual_review', 'ops_session_order_conflict', 'ops_missing_customer_email');
  END IF;

  -- R3 §三: a customer-audience row dead-lettering specifically because
  -- the order has no email on file is not just "stop retrying it" — it is
  -- a fact operations needs to know and currently has NO independent
  -- signal for (they'd otherwise only see whatever the ORIGINAL business
  -- outcome email said, with no indication the customer never got their
  -- own copy). Atomically insert a dedicated, ops-only alert row for it,
  -- in the SAME transaction as the dead-letter status change, so the two
  -- facts can never separate (one without the other). ON CONFLICT (dedupe_key)
  -- DO NOTHING makes this safe against Stripe redelivering the same event.
  IF p_outcome = 'dead_letter' AND p_error_message = 'missing_customer_email' THEN
    SELECT sl.order_id, sl.stripe_session_id INTO v_order_id, v_session_id
    FROM public.send_logs sl
    WHERE sl.dedupe_key = p_dedupe_key;

    INSERT INTO public.send_logs
      (order_id, stripe_session_id, audience, notification_type, dedupe_key, status)
    VALUES
      (v_order_id, v_session_id, 'ops', 'ops_missing_customer_email',
       v_order_id || ':' || v_session_id || ':ops:ops_missing_customer_email', 'pending')
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_webhook_notification_v1(text, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_webhook_notification_v1(text, uuid, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.complete_webhook_notification_v1(text, uuid, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_webhook_notification_v1(text, uuid, text, text, text) TO service_role;

-- Explicitly NOT modified: public.lock_inventory_v2 stays exactly as-is.
-- Explicitly NOT created: any webhook_events table.
