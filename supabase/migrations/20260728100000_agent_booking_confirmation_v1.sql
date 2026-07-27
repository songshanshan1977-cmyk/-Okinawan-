-- 20260728100000_agent_booking_confirmation_v1.sql
--
-- DRAFT — sandbox/agent-confirmation-v1. NOT applied to production. NEVER
-- executed against any real or local Postgres in this round (no
-- Docker/local Postgres/Supabase MCP available in this environment,
-- consistent with every other migration in this overall engagement) —
-- static text review and mocked-RPC-contract Jest tests only.
--
-- A2: adds the durable record of "the customer explicitly agreed to this
-- exact summary_hash" that confirm_booking_summary (lib/agent/tools/
-- confirmBookingSummary.js) writes and A3 will later read before it may
-- ever generate a one-time payment link. This migration is pure DDL — no
-- function/RPC — matching the style of the A1 idempotency migration
-- (20260727090000_agent_booking_idempotency_v1.sql), which this file does
-- NOT modify.
--
-- =============================================================
-- SCHEMA ASSUMPTIONS (this migration has NOT been verified against any
-- real database):
-- =============================================================
--   - public.orders already exists (assumed from every other Agent A1/A2
--     migration and every existing INSERT/UPDATE in this codebase).
--   - Every EXISTING row in public.orders has NULL for both new columns
--     (they did not exist before this migration ran) — no backfill is
--     needed or performed; both columns are nullable and the CHECK
--     constraint below explicitly allows "both NULL" as a valid state.

-- =============================================================
-- 1. orders columns (both nullable — no backfill, no NOT NULL constraint).
-- =============================================================
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS agent_summary_confirmed_hash text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS agent_summary_confirmed_at timestamptz;

-- =============================================================
-- 2. Named CHECK constraint: the two new columns must be either BOTH NULL
--    (never confirmed / confirmation cleared by an update) or BOTH
--    NOT NULL (confirmed) — never one without the other. This is exactly
--    the invariant lib/agent/tools/confirmBookingSummary.js and
--    lib/agent/tools/updateBookingDraft.js's application code already
--    maintains (confirm always writes both together; update always clears
--    both together) — the constraint makes that invariant a real database
--    guarantee, not just an application convention.
-- =============================================================
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS` syntax, so existence is
-- checked explicitly against pg_constraint first — the same idempotent-
-- migration pattern the A1 idempotency migration's named UNIQUE constraint
-- already uses.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_agent_summary_confirmation_both_or_neither_chk'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_agent_summary_confirmation_both_or_neither_chk
      CHECK (
        (agent_summary_confirmed_hash IS NULL AND agent_summary_confirmed_at IS NULL)
        OR
        (agent_summary_confirmed_hash IS NOT NULL AND agent_summary_confirmed_at IS NOT NULL)
      );
  END IF;
END
$$;

-- Explicitly NOT created: any index on agent_summary_confirmed_hash — there
-- is no current business need to look orders up BY confirmed hash (only
-- ever read by order_id, which is already indexed as the table's own
-- unique/primary key). Explicitly NOT created: any function/RPC — all
-- confirmation-decision logic (idempotent replay vs stale vs first-time
-- write) lives in lib/agent/tools/confirmBookingSummary.js on the Node
-- side. Explicitly NOT modified: any PR #2 migration, the A1 idempotency
-- migration, or any existing payments/inventory/orders business column.
