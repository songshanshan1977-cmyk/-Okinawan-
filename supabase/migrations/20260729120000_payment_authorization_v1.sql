-- 20260729120000_payment_authorization_v1.sql
--
-- DRAFT — sandbox/order-access-payment-token-v1. NOT applied to production.
-- NEVER executed against any real or local Postgres in this round (no
-- Docker/local Postgres/Supabase MCP available in this environment,
-- consistent with every other migration in this engagement) — static text
-- review and mocked-RPC-contract Jest tests only. DB INTEGRATION UNVERIFIED.
--
-- Never applied to any real database yet — this file is edited IN PLACE for
-- this round (payment-attempt idempotency) rather than superseded by a new
-- timestamped migration, per this round's explicit instruction. There is no
-- "old shape" of this migration to stay backward-compatible with.
--
-- A3: a short-lived, one-time, database-stateful payment authorization that
-- must be consumed atomically before pages/api/create-payment-intent.js (web)
-- or lib/agent/tools/createPaymentLink.js (Agent) may ever create a Stripe
-- Checkout Session. Replaces "knowing an order_id is enough" with "holding a
-- currently-valid, unconsumed, order-bound, summary-bound authorization is
-- required".
--
-- Payment-attempt idempotency (this revision): the SAME order_id + SAME
-- summary_hash must always resolve to the SAME payment_attempt_id, which
-- becomes the Stripe idempotency key lib/payment/createCheckoutSession.js
-- passes to stripe.checkout.sessions.create — so a retried Agent call, a
-- retried web request, or two genuinely concurrent issuance requests can
-- never create a second Stripe Checkout Session for the content the
-- customer already agreed to pay for.
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
--     payment_status, inventory_status, stripe_session_id.
--   - Every EXISTING row in public.orders has NULL for all six new columns
--     (they did not exist before this migration ran) — no backfill is
--     needed or performed; all six columns are nullable and the CHECK
--     constraint below explicitly allows "all-null" (never authorized) as a
--     valid state.

-- =============================================================
-- 1. orders columns (all nullable — no backfill, no NOT NULL constraint).
--    The raw one-time token itself is NEVER stored anywhere — only its
--    SHA-256 hash (payment_authorization_token_hash). payment_attempt_id is
--    the durable identity of "one customer payment attempt for one specific
--    summary_hash" — it can OUTLIVE any single token: re-issuing a fresh
--    token for the SAME order_id + SAME summary_hash (via
--    issue_payment_authorization_v1 below) while the order is still
--    draft/pending PRESERVES the existing payment_attempt_id rather than
--    minting a new one, which is exactly what lets a retry recover the same
--    Stripe Checkout Session instead of creating a second one.
-- =============================================================
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_authorization_token_hash text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_authorization_summary_hash text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_authorization_deposit_amount numeric;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_authorization_expires_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_authorization_consumed_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_attempt_id text;

-- =============================================================
-- 2. Named CHECK constraint: token_hash / summary_hash / deposit_amount /
--    expires_at / payment_attempt_id are either ALL NULL (no current
--    authorization) or ALL NOT NULL (a current authorization exists) —
--    never a partial state. payment_authorization_consumed_at is excluded
--    from this all-or-nothing group on purpose: it must be able to hold
--    NULL (issued, not yet consumed) while the other five are already NOT
--    NULL, and it becomes NOT NULL only once the consume RPC below consumes
--    the authorization.
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
          AND payment_attempt_id IS NULL
        )
        OR
        (
          payment_authorization_token_hash IS NOT NULL
          AND payment_authorization_summary_hash IS NOT NULL
          AND payment_authorization_deposit_amount IS NOT NULL
          AND payment_authorization_expires_at IS NOT NULL
          AND payment_attempt_id IS NOT NULL
        )
      );
  END IF;
END
$$;

-- =============================================================
-- 3. Atomic ISSUE RPC. This is the ONLY way a payment authorization is ever
--    (re-)issued — never a plain application-level UPDATE, which cannot
--    atomically decide "keep the existing attempt id" vs "mint a new one"
--    against a value (the row's OWN current payment_attempt_id/
--    summary_hash) that a concurrent issuer could be changing at the same
--    time. The decision (CASE expression below) and the write happen in the
--    SAME UPDATE statement, which takes a row lock on this order for the
--    duration of the statement: if two callers race to issue an
--    authorization for the same order_id at the same time, Postgres
--    serializes them — the first to acquire the lock commits its decision,
--    and the second (blocked until the first commits) then evaluates its
--    CASE against the FIRST caller's already-committed payment_attempt_id/
--    summary_hash, not the pre-race value. When both callers are issuing
--    for the SAME summary_hash (the only case this matters for), the
--    second caller's CASE condition is now true against the first caller's
--    committed row, so it keeps the SAME payment_attempt_id the first
--    caller just set — never its own candidate. Two concurrent issuers can
--    never disagree.
--
--    Decision rule: keep the order's EXISTING payment_attempt_id if, and
--    only if, all three hold:
--      - payment_attempt_id IS NOT NULL (an attempt already exists)
--      - payment_authorization_summary_hash = p_summary_hash (issuing for
--        the exact same confirmed content, not a changed order)
--      - payment_status IN ('draft', 'pending') (still a live order, not
--        paid/cancelled)
--    Otherwise, use the caller-generated p_candidate_attempt_id as the new
--    authoritative attempt id.
--
--    Every issuance ALWAYS overwrites token_hash / summary_hash /
--    deposit_amount / expires_at and resets consumed_at to NULL — a fresh
--    token is always minted, even when the attempt id itself is preserved.
--    Only payment_attempt_id is conditionally kept vs replaced.
--
--    Returns just (order_id, payment_attempt_id) — the caller
--    (lib/payment/paymentAuthorization.js) needs nothing else back from
--    this RPC; it already knows every other value it just asked to write.
-- =============================================================
CREATE OR REPLACE FUNCTION public.issue_payment_authorization_v1(
  p_order_id text,
  p_token_hash text,
  p_candidate_attempt_id text,
  p_summary_hash text,
  p_deposit_amount numeric,
  p_expires_at timestamptz
)
RETURNS TABLE (
  order_id text,
  payment_attempt_id text
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.orders AS o
  SET
    payment_authorization_token_hash = p_token_hash,
    payment_authorization_summary_hash = p_summary_hash,
    payment_authorization_deposit_amount = p_deposit_amount,
    payment_authorization_expires_at = p_expires_at,
    payment_authorization_consumed_at = NULL,
    payment_attempt_id = CASE
      WHEN o.payment_attempt_id IS NOT NULL
        AND o.payment_authorization_summary_hash = p_summary_hash
        AND o.payment_status IN ('draft', 'pending')
      THEN o.payment_attempt_id
      ELSE p_candidate_attempt_id
    END
  WHERE o.order_id = p_order_id
  RETURNING o.order_id, o.payment_attempt_id;
END;
$$;

-- =============================================================
-- 4. Atomic CONSUME RPC. Unchanged atomicity story from the original round
--    of this migration — never a "SELECT then UPDATE" pair from application
--    code. The single UPDATE ... WHERE ... RETURNING statement below is one
--    atomic operation as far as Postgres's MVCC/row-locking is concerned:
--    of any number of concurrent callers passing the same (p_order_id,
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
--    amount, (c) re-check inventory, (d) create (or, via the SAME Stripe
--    idempotency key, resume) the Stripe Checkout Session, and (e) know
--    which payment_attempt_id to key that idempotency request on, plus the
--    order's own last-known stripe_session_id — exactly
--    lib/agent/bookingSummary.js's HASHED_FIELDS, plus payment_status/
--    inventory_status, the two payment_authorization_* comparison columns,
--    payment_attempt_id, and stripe_session_id. Never returns name, phone,
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
  payment_authorization_deposit_amount numeric,
  payment_attempt_id text,
  stripe_session_id text
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
    o.payment_authorization_deposit_amount,
    o.payment_attempt_id,
    o.stripe_session_id;
END;
$$;

-- Explicitly NOT created: any index on payment_authorization_token_hash or
-- payment_attempt_id — lookups are always scoped by order_id (already
-- indexed as the table's own unique/primary key) together with the token
-- hash, and authorization/attempt volume is bounded by active-order volume,
-- not a separate high-cardinality table. Explicitly NOT modified: any PR #2
-- migration, the A1 idempotency migration, the A2 confirmation migration,
-- pages/api/stripe-webhook.js, or any existing payments/inventory/orders
-- business column.
