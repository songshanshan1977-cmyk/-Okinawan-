-- 20260722120000_webhook_fail_safe_v1.sql
--
-- DRAFT — sandbox/webhook-fail-safe-v1. NOT applied to production.
-- Revised in the Codex Draft-PR-#2 blocking-fix round to address B-01
-- (RPC callable by anon/authenticated) and B-02 (second real Stripe
-- Session for an already-paid order silently dropped the payment fact).
--
-- DB INTEGRATION UNVERIFIED: written against the orders/payments/inventory
-- schema captured by direct query in earlier rounds of this engagement.
-- Supabase MCP was unreachable again this round, so this file has NOT been
-- re-verified against the live schema and has NOT been executed against
-- any Postgres instance (no local psql/docker available in this
-- environment either). Before applying to any real database:
--   1. Re-confirm orders/payments/inventory column names, types and
--      existing constraints match the assumptions below.
--   2. Run `SELECT stripe_session_id, count(*) FROM payments
--      WHERE stripe_session_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;`
--      — if this returns any rows, the CREATE UNIQUE INDEX below will fail
--      and those duplicates must be reconciled first.
--   3. Apply in a staging environment and run the accompanying SQL test
--      plan before any production rollout.
--
-- Explicitly does NOT touch: public.lock_inventory_v2 (left completely
-- unmodified — other, unknown callers may still depend on it), and does
-- NOT create a webhook_events table (out of scope per instructions).
--
-- See 20260722130000_webhook_notification_outbox_v1.sql for the
-- send_logs-based notification outbox and its claim/complete RPCs
-- (B-03/B-04 fix) — that migration must be applied AFTER this one, since
-- process_checkout_payment_v1 below inserts into the new send_logs columns
-- it defines.

-- =============================================================
-- 1. payments schema additions (B-02) + session uniqueness
-- =============================================================
-- Prevents two different payment rows from ever recording the same Stripe
-- Checkout Session — this is the DB-level backstop behind the RPC's own
-- session-level dedup check. Deliberately NOT unique on order_id: a single
-- order can legitimately accumulate more than one payments row over time
-- (a first Session that fails validation, followed by a second, genuinely
-- successful Session; or two genuinely distinct successful Sessions, which
-- B-02 below now requires to both be recorded) — each such event is an
-- independent Stripe payment fact that must be retained, not collapsed.
CREATE UNIQUE INDEX IF NOT EXISTS payments_stripe_session_id_unique_idx
  ON public.payments (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

-- B-02: every distinct payments row now records WHY process_checkout_
-- payment_v1 classified it the way it did, so "duplicate_payment_conflict"
-- and "failed" rows are self-explanatory on later audit without having to
-- cross-reference webhook logs.
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS processing_result text;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS processing_reason text;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS processed_at timestamptz;

-- =============================================================
-- 2. process_checkout_payment_v1 — atomic checkout-completed handler
-- =============================================================
-- Single source of truth for turning one Stripe `checkout.session.completed`
-- event (already verified as session.payment_status === 'paid' by the
-- Node webhook before this is ever called) into a consistent, atomic
-- orders/payments/inventory/notification-outbox state change.
--
-- Design principles:
--   - All business fields (dates, car model, driver language, deposit
--     amount) are read from the `orders` row inside this function's own
--     transaction, under FOR UPDATE — never trusted from the caller.
--   - p_amount / p_currency / p_stripe_session_id ARE caller-supplied,
--     because they originate from Stripe itself (the thing being
--     validated), not from application business logic.
--   - B-02: every NEW (never-seen-before) stripe_session_id that reaches a
--     terminal branch — success, any validation failure, OR "this order is
--     already paid by a different session" — records its own independent
--     payments row with processing_result/processing_reason. Only an EXACT
--     replay of an already-recorded session_id+order_id pair is a true
--     no-write idempotent replay ("already_processed").
--   - B-03/B-04: every terminal branch that produces a customer-facing or
--     ops-facing outcome also inserts the matching send_logs outbox
--     row(s) in the SAME transaction, via ON CONFLICT (dedupe_key) DO
--     NOTHING — so a payments fact and its notification task are always
--     created atomically together, never one without the other.
--   - SECURITY DEFINER + fixed search_path (B-01): this function must be
--     callable only by the service_role key the Vercel webhook holds, not
--     by anon/authenticated Supabase clients. No dynamic SQL is used
--     anywhere in this function (every statement is a static, literal SQL
--     string built entirely from plpgsql bind variables — never string
--     concatenation or EXECUTE), so there is no SQL-injection surface
--     regardless of caller. All object references are schema-qualified
--     (public.orders / public.payments / public.inventory / public.
--     send_logs) so a hijacked search_path on the calling session cannot
--     redirect this function onto attacker-controlled objects.
CREATE OR REPLACE FUNCTION public.process_checkout_payment_v1(
  p_order_id text,
  p_stripe_session_id text,
  p_amount integer,
  p_currency text,
  p_id_source_conflict boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_order public.orders%ROWTYPE;
  v_existing_payment_order_id text;
  v_existing_reason text;
  v_end_date date;
  v_driver_lang text;
  v_missing_count integer;
  v_short_count integer;
BEGIN
  -- Guard: p_order_id must be provided.
  IF p_order_id IS NULL OR length(trim(p_order_id)) = 0 THEN
    RAISE EXCEPTION 'process_checkout_payment_v1: p_order_id is required'
      USING ERRCODE = 'P0001';
  END IF;

  -- B-02 item 5: p_stripe_session_id must never be NULL or blank — every
  -- payments row this function writes is keyed on it, and the whole
  -- session-level idempotency design depends on it being a real value.
  IF p_stripe_session_id IS NULL OR length(trim(p_stripe_session_id)) = 0 THEN
    RAISE EXCEPTION 'process_checkout_payment_v1: p_stripe_session_id is required'
      USING ERRCODE = 'P0003';
  END IF;

  -- 1. Lock the order row for the remainder of this transaction.
  SELECT * INTO v_order
  FROM public.orders
  WHERE order_id = p_order_id
  FOR UPDATE;

  -- 2. Order not found: raise so Node returns 5xx and Stripe retries.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'process_checkout_payment_v1: order_not_found: %', p_order_id
      USING ERRCODE = 'P0002';
  END IF;

  -- 3. Session-level idempotency: has this exact Stripe Session already
  -- been recorded against ANY order?
  SELECT order_id INTO v_existing_payment_order_id
  FROM public.payments
  WHERE stripe_session_id = p_stripe_session_id
  LIMIT 1;

  IF FOUND THEN
    IF v_existing_payment_order_id = p_order_id THEN
      -- Exact replay (Stripe redelivery, or our own webhook retrying after
      -- a notification failure) — idempotent, no new payments row and no
      -- new outbox row (the original terminal branch already inserted
      -- both, atomically, the first time this session_id was seen).
      -- Surface the ORIGINAL processing_reason too, so Node can rebuild
      -- the correct email content on a pure retry without a second query.
      SELECT processing_reason INTO v_existing_reason
      FROM public.payments
      WHERE stripe_session_id = p_stripe_session_id
        AND order_id = p_order_id
      ORDER BY created_at DESC
      LIMIT 1;

      RETURN jsonb_build_object(
        'result', 'already_processed',
        'reason', v_existing_reason,
        'order_id', v_order.order_id,
        'inventory_status', v_order.inventory_status
      );
    ELSE
      -- Same Stripe Session somehow bound to a DIFFERENT order_id than
      -- this call is claiming. Never happens in the legitimate flow — do
      -- not touch inventory/payment state for either order, no new write
      -- (this Session already has its own payments row under the other
      -- order_id; writing a second row here would falsely double-count
      -- the same real-world Stripe payment).
      RETURN jsonb_build_object(
        'result', 'duplicate_payment_conflict',
        'reason', 'stripe_session_id_bound_to_different_order',
        'order_id', v_order.order_id,
        'inventory_status', v_order.inventory_status
      );
    END IF;
  END IF;

  -- From here on, p_stripe_session_id is NEW — every branch below records
  -- its own independent payments row (B-02) plus matching outbox row(s).

  -- 4. B-02: order already paid by a DIFFERENT, prior Stripe Session. This
  -- second Session is still a REAL, independent Stripe payment fact and
  -- must be recorded as its own payments row — it must NOT be silently
  -- dropped. orders itself is intentionally left untouched here
  -- (payment_status stays 'paid', inventory_status/inventory_locked/status
  -- keep whatever the FIRST session already produced) — this second
  -- session did not itself lock any inventory and must not silently
  -- overwrite the first session's recorded outcome.
  IF v_order.payment_status = 'paid' THEN
    INSERT INTO public.payments
      (order_id, amount, currency, stripe_session_id, car_model_id, paid,
       processing_result, processing_reason, processed_at)
    VALUES
      (p_order_id, p_amount, p_currency, p_stripe_session_id, v_order.car_model_id, true,
       'duplicate_payment_conflict', 'order_already_paid_by_different_session', now());

    INSERT INTO public.send_logs
      (order_id, stripe_session_id, audience, notification_type, dedupe_key, status)
    VALUES
      (p_order_id, p_stripe_session_id, 'customer', 'customer_manual_review',
       p_order_id || ':' || p_stripe_session_id || ':customer:customer_manual_review', 'pending'),
      (p_order_id, p_stripe_session_id, 'ops', 'ops_manual_review',
       p_order_id || ':' || p_stripe_session_id || ':ops:ops_manual_review', 'pending')
    ON CONFLICT (dedupe_key) DO NOTHING;

    RETURN jsonb_build_object(
      'result', 'duplicate_payment_conflict',
      'reason', 'order_already_paid_by_different_session',
      'order_id', p_order_id,
      'inventory_status', v_order.inventory_status
    );
  END IF;

  -- 5. Node detected that Stripe's metadata.order_id and
  -- client_reference_id disagreed, and could only reliably resolve to
  -- THIS order_id. Record the payment fact as failed and require review.
  IF p_id_source_conflict THEN
    INSERT INTO public.payments
      (order_id, amount, currency, stripe_session_id, car_model_id, paid,
       processing_result, processing_reason, processed_at)
    VALUES
      (p_order_id, p_amount, p_currency, p_stripe_session_id, v_order.car_model_id, true,
       'failed', 'order_id_source_mismatch', now());

    UPDATE public.orders
    SET payment_status = 'paid',
        inventory_status = 'failed',
        inventory_locked = false,
        status = 'new'
    WHERE order_id = p_order_id;

    INSERT INTO public.send_logs
      (order_id, stripe_session_id, audience, notification_type, dedupe_key, status)
    VALUES
      (p_order_id, p_stripe_session_id, 'customer', 'customer_manual_review',
       p_order_id || ':' || p_stripe_session_id || ':customer:customer_manual_review', 'pending'),
      (p_order_id, p_stripe_session_id, 'ops', 'ops_manual_review',
       p_order_id || ':' || p_stripe_session_id || ':ops:ops_manual_review', 'pending')
    ON CONFLICT (dedupe_key) DO NOTHING;

    RETURN jsonb_build_object(
      'result', 'failed',
      'reason', 'order_id_source_mismatch',
      'order_id', p_order_id,
      'inventory_status', 'failed'
    );
  END IF;

  -- 6. Currency check — deposit is always charged in CNY.
  IF p_currency IS NULL OR lower(p_currency) <> 'cny' THEN
    INSERT INTO public.payments
      (order_id, amount, currency, stripe_session_id, car_model_id, paid,
       processing_result, processing_reason, processed_at)
    VALUES
      (p_order_id, p_amount, p_currency, p_stripe_session_id, v_order.car_model_id, true,
       'failed', 'currency_mismatch', now());

    UPDATE public.orders
    SET payment_status = 'paid',
        inventory_status = 'failed',
        inventory_locked = false,
        status = 'new'
    WHERE order_id = p_order_id;

    INSERT INTO public.send_logs
      (order_id, stripe_session_id, audience, notification_type, dedupe_key, status)
    VALUES
      (p_order_id, p_stripe_session_id, 'customer', 'customer_manual_review',
       p_order_id || ':' || p_stripe_session_id || ':customer:customer_manual_review', 'pending'),
      (p_order_id, p_stripe_session_id, 'ops', 'ops_manual_review',
       p_order_id || ':' || p_stripe_session_id || ':ops:ops_manual_review', 'pending')
    ON CONFLICT (dedupe_key) DO NOTHING;

    RETURN jsonb_build_object(
      'result', 'failed',
      'reason', 'currency_mismatch',
      'order_id', p_order_id,
      'inventory_status', 'failed'
    );
  END IF;

  -- 7. Amount check.
  IF p_amount IS NULL OR p_amount <> (v_order.deposit_amount * 100) THEN
    INSERT INTO public.payments
      (order_id, amount, currency, stripe_session_id, car_model_id, paid,
       processing_result, processing_reason, processed_at)
    VALUES
      (p_order_id, p_amount, p_currency, p_stripe_session_id, v_order.car_model_id, true,
       'failed', 'amount_mismatch', now());

    UPDATE public.orders
    SET payment_status = 'paid',
        inventory_status = 'failed',
        inventory_locked = false,
        status = 'new'
    WHERE order_id = p_order_id;

    INSERT INTO public.send_logs
      (order_id, stripe_session_id, audience, notification_type, dedupe_key, status)
    VALUES
      (p_order_id, p_stripe_session_id, 'customer', 'customer_manual_review',
       p_order_id || ':' || p_stripe_session_id || ':customer:customer_manual_review', 'pending'),
      (p_order_id, p_stripe_session_id, 'ops', 'ops_manual_review',
       p_order_id || ':' || p_stripe_session_id || ':ops:ops_manual_review', 'pending')
    ON CONFLICT (dedupe_key) DO NOTHING;

    RETURN jsonb_build_object(
      'result', 'failed',
      'reason', 'amount_mismatch',
      'order_id', p_order_id,
      'inventory_status', 'failed'
    );
  END IF;

  -- 8. Resolve date range / driver_lang the way lock_inventory_v2 does.
  v_end_date := COALESCE(v_order.end_date, v_order.start_date);
  v_driver_lang := CASE WHEN upper(coalesce(v_order.driver_lang, '')) = 'JP' THEN 'JP' ELSE 'ZH' END;

  IF v_order.start_date IS NULL OR v_end_date IS NULL OR v_end_date < v_order.start_date THEN
    INSERT INTO public.payments
      (order_id, amount, currency, stripe_session_id, car_model_id, paid,
       processing_result, processing_reason, processed_at)
    VALUES
      (p_order_id, p_amount, p_currency, p_stripe_session_id, v_order.car_model_id, true,
       'failed', 'invalid_date_range', now());

    UPDATE public.orders
    SET payment_status = 'paid',
        inventory_status = 'failed',
        inventory_locked = false,
        status = 'new'
    WHERE order_id = p_order_id;

    INSERT INTO public.send_logs
      (order_id, stripe_session_id, audience, notification_type, dedupe_key, status)
    VALUES
      (p_order_id, p_stripe_session_id, 'customer', 'customer_manual_review',
       p_order_id || ':' || p_stripe_session_id || ':customer:customer_manual_review', 'pending'),
      (p_order_id, p_stripe_session_id, 'ops', 'ops_manual_review',
       p_order_id || ':' || p_stripe_session_id || ':ops:ops_manual_review', 'pending')
    ON CONFLICT (dedupe_key) DO NOTHING;

    RETURN jsonb_build_object(
      'result', 'failed',
      'reason', 'invalid_date_range',
      'order_id', p_order_id,
      'inventory_status', 'failed'
    );
  END IF;

  -- 9. Lock every candidate inventory row in range before inspecting them.
  PERFORM 1
  FROM public.inventory
  WHERE car_model_id = v_order.car_model_id
    AND driver_lang = v_driver_lang
    AND date BETWEEN v_order.start_date AND v_end_date
  FOR UPDATE;

  -- 10. Every day in [start_date, end_date] must have an inventory row
  -- (closes the legacy lock_inventory_v2 "missing row silently skipped"
  -- gap identified in the round-8 read-only audit).
  SELECT count(*) INTO v_missing_count
  FROM generate_series(v_order.start_date, v_end_date, interval '1 day') AS d(day)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.inventory i
    WHERE i.car_model_id = v_order.car_model_id
      AND i.driver_lang = v_driver_lang
      AND i.date = d.day::date
  );

  IF v_missing_count > 0 THEN
    INSERT INTO public.payments
      (order_id, amount, currency, stripe_session_id, car_model_id, paid,
       processing_result, processing_reason, processed_at)
    VALUES
      (p_order_id, p_amount, p_currency, p_stripe_session_id, v_order.car_model_id, true,
       'failed', 'failed_missing_inventory', now());

    UPDATE public.orders
    SET payment_status = 'paid',
        inventory_status = 'failed',
        inventory_locked = false,
        status = 'new'
    WHERE order_id = p_order_id;

    INSERT INTO public.send_logs
      (order_id, stripe_session_id, audience, notification_type, dedupe_key, status)
    VALUES
      (p_order_id, p_stripe_session_id, 'customer', 'customer_manual_review',
       p_order_id || ':' || p_stripe_session_id || ':customer:customer_manual_review', 'pending'),
      (p_order_id, p_stripe_session_id, 'ops', 'ops_manual_review',
       p_order_id || ':' || p_stripe_session_id || ':ops:ops_manual_review', 'pending')
    ON CONFLICT (dedupe_key) DO NOTHING;

    RETURN jsonb_build_object(
      'result', 'failed',
      'reason', 'failed_missing_inventory',
      'order_id', p_order_id,
      'inventory_status', 'failed'
    );
  END IF;

  -- 11. Every day's row must have remaining capacity.
  SELECT count(*) INTO v_short_count
  FROM public.inventory
  WHERE car_model_id = v_order.car_model_id
    AND driver_lang = v_driver_lang
    AND date BETWEEN v_order.start_date AND v_end_date
    AND (total_qty - booked_qty - locked_qty) <= 0;

  IF v_short_count > 0 THEN
    INSERT INTO public.payments
      (order_id, amount, currency, stripe_session_id, car_model_id, paid,
       processing_result, processing_reason, processed_at)
    VALUES
      (p_order_id, p_amount, p_currency, p_stripe_session_id, v_order.car_model_id, true,
       'failed', 'failed_no_stock', now());

    UPDATE public.orders
    SET payment_status = 'paid',
        inventory_status = 'failed',
        inventory_locked = false,
        status = 'new'
    WHERE order_id = p_order_id;

    INSERT INTO public.send_logs
      (order_id, stripe_session_id, audience, notification_type, dedupe_key, status)
    VALUES
      (p_order_id, p_stripe_session_id, 'customer', 'customer_manual_review',
       p_order_id || ':' || p_stripe_session_id || ':customer:customer_manual_review', 'pending'),
      (p_order_id, p_stripe_session_id, 'ops', 'ops_manual_review',
       p_order_id || ':' || p_stripe_session_id || ':ops:ops_manual_review', 'pending')
    ON CONFLICT (dedupe_key) DO NOTHING;

    RETURN jsonb_build_object(
      'result', 'failed',
      'reason', 'failed_no_stock',
      'order_id', p_order_id,
      'inventory_status', 'failed'
    );
  END IF;

  -- 12. Success path: lock every day in range, record the payment, flip
  -- the order to paid + locked + new, insert the success outbox rows.
  -- All in this same transaction.
  UPDATE public.inventory
  SET locked_qty = locked_qty + 1
  WHERE car_model_id = v_order.car_model_id
    AND driver_lang = v_driver_lang
    AND date BETWEEN v_order.start_date AND v_end_date;

  INSERT INTO public.payments
    (order_id, amount, currency, stripe_session_id, car_model_id, paid,
     processing_result, processing_reason, processed_at)
  VALUES
    (p_order_id, p_amount, p_currency, p_stripe_session_id, v_order.car_model_id, true,
     'locked', NULL, now());

  UPDATE public.orders
  SET payment_status = 'paid',
      inventory_status = 'locked',
      inventory_locked = true,
      status = 'new'
  WHERE order_id = p_order_id;

  INSERT INTO public.send_logs
    (order_id, stripe_session_id, audience, notification_type, dedupe_key, status)
  VALUES
    (p_order_id, p_stripe_session_id, 'customer', 'customer_booking_confirmed',
     p_order_id || ':' || p_stripe_session_id || ':customer:customer_booking_confirmed', 'pending'),
    (p_order_id, p_stripe_session_id, 'ops', 'ops_booking_confirmed',
     p_order_id || ':' || p_stripe_session_id || ':ops:ops_booking_confirmed', 'pending')
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN jsonb_build_object(
    'result', 'locked',
    'reason', null,
    'order_id', p_order_id,
    'inventory_status', 'locked'
  );
END;
$function$;

-- B-01: only the Vercel webhook's service_role connection may call this
-- function. anon/authenticated Supabase clients (e.g. a signed-in customer
-- browser session, or an unauthenticated one) must never be able to invoke
-- it directly and force arbitrary payments/orders/inventory/send_logs
-- writes. REVOKE the broad grants PostgreSQL applies by default to any
-- newly created function, then GRANT EXECUTE back only to service_role.
-- Signature must match the CREATE FUNCTION above exactly.
REVOKE ALL ON FUNCTION public.process_checkout_payment_v1(text, text, integer, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_checkout_payment_v1(text, text, integer, text, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.process_checkout_payment_v1(text, text, integer, text, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_checkout_payment_v1(text, text, integer, text, boolean) TO service_role;

-- Explicitly NOT modified: public.lock_inventory_v2 stays exactly as-is.
-- Explicitly NOT created: any webhook_events table.
