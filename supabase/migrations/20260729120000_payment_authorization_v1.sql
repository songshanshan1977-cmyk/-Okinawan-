-- 20260729120000_payment_authorization_v1.sql
--
-- DRAFT — sandbox/order-access-payment-token-v1. NOT applied to production.
-- NEVER executed against any real or local Postgres in this round (no
-- Docker/local Postgres/Supabase MCP available in this environment,
-- consistent with every other migration in this engagement) — static text
-- review and mocked-RPC-contract Jest tests only. DB INTEGRATION UNVERIFIED.
--
-- A3: a short-lived, one-time, database-stateful payment authorization that
-- must be consumed atomically before pages/api/create-payment-intent.js (web)
-- or lib/agent/tools/createPaymentLink.js (Agent) may ever create a Stripe
-- Checkout Session. Replaces "knowing an order_id is enough" with "holding a
-- currently-valid, unconsumed, order-bound, summary-bound authorization is
-- required".
--
-- =============================================================
-- SCHEMA ASSUMPTIONS (this migration has NOT been verified against any
-- real database):
-- =============================================================
--   - public.orders already exists, with (at least) the columns every
--     existing Agent A1/A2 migration and every existing INSERT/UPDATE in
--     this codebase already assumes: order_id (text, primary key/unique),
--     start_date, end_date, car_model_id, driver_lang, duration, pax,
--     luggage, departure_hotel, end_hotel, total_price, deposit_amount,
--     payment_status, inventory_status.
--   - Every EXISTING row in public.orders has NULL for all five new columns
--     (they did not exist before this migration ran) — no backfill is
--     needed or performed; all five columns are nullable and the CHECK
--     constraint below explicitly allows "all-null" (never authorized) as a
--     valid state.

-- =============================================================
-- 1. orders columns (all nullable — no backfill, no NOT NULL constraint).
--    The raw one-time token itself is NEVER stored anywhere — only its
--    SHA-256 hash (payment_authorization_token_hash). Each order has AT
--    MOST one current authorization: re-issuing (lib/payment/
--    paymentAuthorization.js's issuePaymentAuthorization) always overwrites
--    all five columns in a single UPDATE, which immediately invalidates any
--    previously-issued raw token for that order (its hash no longer matches
--    what is stored, so lib/payment/createCheckoutSession.js's consume RPC
--    can never match it again).
-- =============================================================
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_authorization_token_hash text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_authorization_summary_hash text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_authorization_deposit_amount numeric;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_authorization_expires_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_authorization_consumed_at timestamptz;

-- =============================================================
-- 2. Named CHECK constraint: the first four columns are either ALL NULL (no
--    current authorization) or ALL NOT NULL (a current authorization
--    exists) — never a partial state. payment_authorization_consumed_at is
--    excluded from this all-or-nothing group on purpose: it must be able to
--    hold NULL (issued, not yet consumed) while the other four are already
--    NOT NULL, and it becomes NOT NULL only once the RPC below consumes the
--    authorization.
-- =============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_payment_authorization_all_or_none_chk'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_payment_authorization_all_or_none_chk
      CHECK (
        (
          payment_authorization_token_hash IS NULL
          AND payment_authorization_summary_hash IS NULL
          AND payment_authorization_deposit_amount IS NULL
          AND payment_authorization_expires_at IS NULL
        )
        OR
        (
          payment_authorization_token_hash IS NOT NULL
          AND payment_authorization_summary_hash IS NOT NULL
          AND payment_authorization_deposit_amount IS NOT NULL
          AND payment_authorization_expires_at IS NOT NULL
        )
      );
  END IF;
END
$$;

-- =============================================================
-- 3. Atomic consume RPC. This is the ONLY way an authorization is ever
--    consumed — never a "SELECT then UPDATE" pair from application code,
--    which would leave a window for two concurrent requests holding the
--    same raw token to both read "still valid" before either writes. The
--    single UPDATE ... WHERE ... RETURNING statement below is one atomic
--    operation as far as Postgres's MVCC/row-locking is concerned: of any
--    number of concurrent callers passing the same (p_order_id,
--    p_token_hash), at most one UPDATE can match the still-unconsumed row
--    and return a row; every other concurrent caller's WHERE clause no
--    longer matches (payment_authorization_consumed_at is no longer NULL)
--    and that call returns zero rows.
--
--    Match conditions (all required):
--      - order_id = p_order_id
--      - payment_authorization_token_hash = p_token_hash
--      - payment_authorization_consumed_at IS NULL   (not already used)
--      - payment_authorization_expires_at > now()    (not expired)
--      - payment_status IN ('draft', 'pending')      (still editable/payable)
--
--    Returns the whitelisted fields lib/payment/createCheckoutSession.js
--    needs to (a) recompute the current summary_hash via
--    lib/agent/bookingSummary.js's computeSummaryHash and compare it
--    against payment_authorization_summary_hash, (b) re-verify the deposit
--    amount, (c) re-check inventory, and (d) create the Stripe Checkout
--    Session — exactly lib/agent/bookingSummary.js's HASHED_FIELDS, plus
--    payment_status/inventory_status and the two payment_authorization_*
--    columns callers need to compare against. Never returns name, phone,
--    email, wechat, itinerary, remark, or any other PII/free-text field.
-- =============================================================
CREATE OR REPLACE FUNCTION public.consume_payment_authorization_v1(
  p_order_id text,
  p_token_hash text
)
RETURNS TABLE (
  order_id text,
  start_date date,
  end_date date,
  car_model_id uuid,
  driver_lang text,
  duration integer,
  pax integer,
  luggage integer,
  departure_hotel text,
  end_hotel text,
  total_price numeric,
  deposit_amount numeric,
  payment_status text,
  inventory_status text,
  payment_authorization_summary_hash text,
  payment_authorization_deposit_amount numeric
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.orders AS o
  SET payment_authorization_consumed_at = now()
  WHERE o.order_id = p_order_id
    AND o.payment_authorization_token_hash = p_token_hash
    AND o.payment_authorization_consumed_at IS NULL
    AND o.payment_authorization_expires_at > now()
    AND o.payment_status IN ('draft', 'pending')
  RETURNING
    o.order_id,
    o.start_date,
    o.end_date,
    o.car_model_id,
    o.driver_lang,
    o.duration,
    o.pax,
    o.luggage,
    o.departure_hotel,
    o.end_hotel,
    o.total_price,
    o.deposit_amount,
    o.payment_status,
    o.inventory_status,
    o.payment_authorization_summary_hash,
    o.payment_authorization_deposit_amount;
END;
$$;

-- Explicitly NOT created: any index on payment_authorization_token_hash —
-- lookups are always scoped by order_id (already indexed as the table's own
-- unique/primary key) AND the token hash together, and authorization volume
-- is bounded by active-order volume, not a separate high-cardinality table.
-- Explicitly NOT modified: any PR #2 migration, the A1 idempotency
-- migration, the A2 confirmation migration, pages/api/stripe-webhook.js, or
-- any existing payments/inventory/orders business column.
