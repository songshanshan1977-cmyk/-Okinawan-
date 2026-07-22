-- 20260722120000_webhook_fail_safe_v1.sql
--
-- DRAFT — sandbox/webhook-fail-safe-v1. NOT applied to production.
--
-- DB INTEGRATION UNVERIFIED: written against the orders/payments/inventory
-- schema captured by direct query in earlier rounds of this engagement
-- (round 1/2 execute_sql results, re-confirmed by re-reading in round 8).
-- Supabase MCP was unreachable this round, so this file has NOT been
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
--      plan (see the round's final report, section 十二/沙盒测试计划)
--      before any production rollout.
--
-- Explicitly does NOT touch: public.lock_inventory_v2 (left completely
-- unmodified — other, unknown callers may still depend on it), and does
-- NOT create a webhook_events table (out of scope for v1 per instructions).

-- =============================================================
-- 1. payments.stripe_session_id uniqueness (partial: NULLs allowed)
-- =============================================================
-- Prevents two different payment rows from ever recording the same Stripe
-- Checkout Session — this is the DB-level backstop behind the RPC's own
-- session-level dedup check (see process_checkout_payment_v1 step 3 below).
-- Deliberately NOT unique on order_id: a single order can legitimately
-- accumulate more than one payments row over time (e.g. a first Session
-- that fails validation, followed by a second, genuinely successful
-- Session for the same order) — each such event is an independent Stripe
-- payment fact that must be retained, not collapsed.
CREATE UNIQUE INDEX IF NOT EXISTS payments_stripe_session_id_unique_idx
  ON public.payments (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

-- =============================================================
-- 2. process_checkout_payment_v1 — atomic checkout-completed handler
-- =============================================================
-- Single source of truth for turning one Stripe `checkout.session.completed`
-- event (already verified as session.payment_status === 'paid' by the
-- Node webhook before this is ever called) into a consistent, atomic
-- orders/payments/inventory state change.
--
-- Design principles (frozen per v9 instructions):
--   - All business fields (dates, car model, driver language, deposit
--     amount) are read from the `orders` row inside this function's own
--     transaction, under FOR UPDATE — never trusted from the caller, so a
--     compromised or buggy Node layer cannot inject arbitrary business
--     content into the write path.
--   - p_amount / p_currency / p_stripe_session_id ARE caller-supplied,
--     because they originate from Stripe itself (the thing being
--     validated), not from application business logic.
--   - Every branch that can be reached by legitimate retries (Stripe
--     redelivery) is idempotent: same session_id + same order_id always
--     returns the same result without a second write.
--   - Confirmed-mismatch scenarios (bad amount/currency/dates, missing
--     inventory rows, sold-out inventory, order_id source conflict) are
--     NOT exceptions — they still commit a "payment fact recorded, order
--     needs human review" state. Only truly unexpected SQL errors
--     (constraint violations, connectivity issues surfaced as errors
--     inside this function) propagate as a raised exception, which rolls
--     back the whole transaction and is surfaced to Node as `error`
--     (mapped to HTTP 5xx so Stripe retries).
CREATE OR REPLACE FUNCTION public.process_checkout_payment_v1(
  p_order_id text,
  p_stripe_session_id text,
  p_amount integer,
  p_currency text,
  p_id_source_conflict boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_order public.orders%ROWTYPE;
  v_existing_payment_order_id text;
  v_end_date date;
  v_driver_lang text;
  v_missing_count integer;
  v_short_count integer;
BEGIN
  -- Guard: p_order_id must be provided — Node is responsible for the
  -- "order_id completely missing from the Stripe session" case (returns
  -- 200 without ever calling this function), but defend anyway.
  IF p_order_id IS NULL OR length(trim(p_order_id)) = 0 THEN
    RAISE EXCEPTION 'process_checkout_payment_v1: p_order_id is required'
      USING ERRCODE = 'P0001';
  END IF;

  -- 1. Lock the order row for the remainder of this transaction.
  SELECT * INTO v_order
  FROM public.orders
  WHERE order_id = p_order_id
  FOR UPDATE;

  -- 2. Order not found: this is a data-integrity / temporary-failure
  -- situation from the webhook's point of view (the order SHOULD exist —
  -- create-order.js always inserts before Stripe Checkout is ever created),
  -- not a "nothing to do here" situation. Raise so Node returns 5xx and
  -- Stripe retries (the order row may simply not have committed/replicated
  -- yet under extreme timing, or something is genuinely broken).
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
      -- Exact replay of a previously-processed event (Stripe redelivery,
      -- or our own webhook retried after an email failure) — idempotent,
      -- no new write. Node uses inventory_status to know which email
      -- variant to (re)send.
      RETURN jsonb_build_object(
        'result', 'already_processed',
        'reason', 'stripe_session_id_already_recorded_for_this_order',
        'order_id', v_order.order_id,
        'inventory_status', v_order.inventory_status
      );
    ELSE
      -- Same Stripe Session somehow bound to a DIFFERENT order_id than
      -- this call is claiming. Never happens in the legitimate flow —
      -- treat as a deterministic conflict requiring human review, and do
      -- not touch inventory/payment state for either order.
      RETURN jsonb_build_object(
        'result', 'duplicate_payment_conflict',
        'reason', 'stripe_session_id_bound_to_different_order',
        'order_id', v_order.order_id,
        'inventory_status', v_order.inventory_status
      );
    END IF;
  END IF;

  -- 4. Order already paid by a DIFFERENT, prior Stripe Session. Do not
  -- silently accept a second "successful" payment for the same order —
  -- record nothing further automatically, flag for human review.
  IF v_order.payment_status = 'paid' THEN
    RETURN jsonb_build_object(
      'result', 'duplicate_payment_conflict',
      'reason', 'order_already_paid_by_different_session',
      'order_id', v_order.order_id,
      'inventory_status', v_order.inventory_status
    );
  END IF;

  -- 5. Node detected that Stripe's metadata.order_id and
  -- client_reference_id disagreed, and could only reliably resolve to
  -- THIS order_id (the other candidate did not match any existing order).
  -- The mismatch itself is the deterministic-conflict trigger — process no
  -- further business validation, just record the payment fact as failed
  -- and require human review.
  IF p_id_source_conflict THEN
    INSERT INTO public.payments (order_id, amount, currency, stripe_session_id, car_model_id, paid)
    VALUES (p_order_id, p_amount, p_currency, p_stripe_session_id, v_order.car_model_id, true);

    UPDATE public.orders
    SET payment_status = 'paid',
        inventory_status = 'failed',
        inventory_locked = false,
        status = 'new'
    WHERE order_id = p_order_id;

    RETURN jsonb_build_object(
      'result', 'failed',
      'reason', 'order_id_source_mismatch',
      'order_id', p_order_id,
      'inventory_status', 'failed'
    );
  END IF;

  -- 6. Currency check — deposit is always charged in CNY.
  IF p_currency IS NULL OR lower(p_currency) <> 'cny' THEN
    INSERT INTO public.payments (order_id, amount, currency, stripe_session_id, car_model_id, paid)
    VALUES (p_order_id, p_amount, p_currency, p_stripe_session_id, v_order.car_model_id, true);

    UPDATE public.orders
    SET payment_status = 'paid',
        inventory_status = 'failed',
        inventory_locked = false,
        status = 'new'
    WHERE order_id = p_order_id;

    RETURN jsonb_build_object(
      'result', 'failed',
      'reason', 'currency_mismatch',
      'order_id', p_order_id,
      'inventory_status', 'failed'
    );
  END IF;

  -- 7. Amount check — must exactly match this order's own recorded
  -- deposit_amount (in minor units, matching Stripe's amount_total).
  IF p_amount IS NULL OR p_amount <> (v_order.deposit_amount * 100) THEN
    INSERT INTO public.payments (order_id, amount, currency, stripe_session_id, car_model_id, paid)
    VALUES (p_order_id, p_amount, p_currency, p_stripe_session_id, v_order.car_model_id, true);

    UPDATE public.orders
    SET payment_status = 'paid',
        inventory_status = 'failed',
        inventory_locked = false,
        status = 'new'
    WHERE order_id = p_order_id;

    RETURN jsonb_build_object(
      'result', 'failed',
      'reason', 'amount_mismatch',
      'order_id', p_order_id,
      'inventory_status', 'failed'
    );
  END IF;

  -- 8. Resolve the date range / driver_lang exactly the way the legacy
  -- lock_inventory_v2 does (end_date falls back to start_date; driver_lang
  -- normalizes to 'JP' or 'ZH').
  v_end_date := COALESCE(v_order.end_date, v_order.start_date);
  v_driver_lang := CASE WHEN upper(coalesce(v_order.driver_lang, '')) = 'JP' THEN 'JP' ELSE 'ZH' END;

  IF v_order.start_date IS NULL OR v_end_date IS NULL OR v_end_date < v_order.start_date THEN
    INSERT INTO public.payments (order_id, amount, currency, stripe_session_id, car_model_id, paid)
    VALUES (p_order_id, p_amount, p_currency, p_stripe_session_id, v_order.car_model_id, true);

    UPDATE public.orders
    SET payment_status = 'paid',
        inventory_status = 'failed',
        inventory_locked = false,
        status = 'new'
    WHERE order_id = p_order_id;

    RETURN jsonb_build_object(
      'result', 'failed',
      'reason', 'invalid_date_range',
      'order_id', p_order_id,
      'inventory_status', 'failed'
    );
  END IF;

  -- 9. Lock every candidate inventory row in range for this car/lang before
  -- inspecting them, so a concurrent process_checkout_payment_v1 call for
  -- the same car/lang/overlapping range must wait here rather than racing
  -- on the availability check below.
  PERFORM 1
  FROM public.inventory
  WHERE car_model_id = v_order.car_model_id
    AND driver_lang = v_driver_lang
    AND date BETWEEN v_order.start_date AND v_end_date
  FOR UPDATE;

  -- 10. Every day in [start_date, end_date] must have an inventory row.
  -- This is the exact "silent skip" gap identified in the round-8 read-only
  -- audit of the legacy lock_inventory_v2: that function's WHERE-clause
  -- pre-check simply never matches a day with no row at all, so it neither
  -- counts it as missing nor locks it, and returns success regardless.
  -- Here a missing day is its own distinct, explicit failure reason.
  SELECT count(*) INTO v_missing_count
  FROM generate_series(v_order.start_date, v_end_date, interval '1 day') AS d(day)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.inventory i
    WHERE i.car_model_id = v_order.car_model_id
      AND i.driver_lang = v_driver_lang
      AND i.date = d.day::date
  );

  IF v_missing_count > 0 THEN
    INSERT INTO public.payments (order_id, amount, currency, stripe_session_id, car_model_id, paid)
    VALUES (p_order_id, p_amount, p_currency, p_stripe_session_id, v_order.car_model_id, true);

    UPDATE public.orders
    SET payment_status = 'paid',
        inventory_status = 'failed',
        inventory_locked = false,
        status = 'new'
    WHERE order_id = p_order_id;

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
    INSERT INTO public.payments (order_id, amount, currency, stripe_session_id, car_model_id, paid)
    VALUES (p_order_id, p_amount, p_currency, p_stripe_session_id, v_order.car_model_id, true);

    UPDATE public.orders
    SET payment_status = 'paid',
        inventory_status = 'failed',
        inventory_locked = false,
        status = 'new'
    WHERE order_id = p_order_id;

    RETURN jsonb_build_object(
      'result', 'failed',
      'reason', 'failed_no_stock',
      'order_id', p_order_id,
      'inventory_status', 'failed'
    );
  END IF;

  -- 12. Success path: lock every day in range, record the payment, flip
  -- the order to paid + locked + new. All in this same transaction.
  UPDATE public.inventory
  SET locked_qty = locked_qty + 1
  WHERE car_model_id = v_order.car_model_id
    AND driver_lang = v_driver_lang
    AND date BETWEEN v_order.start_date AND v_end_date;

  INSERT INTO public.payments (order_id, amount, currency, stripe_session_id, car_model_id, paid)
  VALUES (p_order_id, p_amount, p_currency, p_stripe_session_id, v_order.car_model_id, true);

  UPDATE public.orders
  SET payment_status = 'paid',
      inventory_status = 'locked',
      inventory_locked = true,
      status = 'new'
  WHERE order_id = p_order_id;

  RETURN jsonb_build_object(
    'result', 'locked',
    'reason', null,
    'order_id', p_order_id,
    'inventory_status', 'locked'
  );
END;
$function$;

-- Explicitly NOT modified: public.lock_inventory_v2 stays exactly as-is.
-- Explicitly NOT created: any webhook_events / event-id dedup table.
