-- 20260727090000_agent_booking_idempotency_v1.sql
--
-- DRAFT — sandbox/agent-tools-v1. NOT applied to production. NEVER
-- executed against any real or local Postgres in this round (no
-- Docker/local Postgres/Supabase MCP available in this environment,
-- consistent with every other migration in this overall engagement) —
-- static text review and mocked-RPC-contract Jest tests only.
--
-- A1-B02: adds the two columns and the one partial unique index
-- lib/agent/tools/createBookingDraft.js's insertIdempotentDraft() needs to
-- make its `INSERT ... ON CONFLICT (agent_idempotency_key_hash) DO NOTHING`
-- (via supabase-js .upsert(row, {onConflict, ignoreDuplicates:true}))
-- genuinely atomic at the database level — this is the real concurrency
-- primitive the A1-B02 instructions require ("不得用『先查再插』冒充并发
-- 安全"): two concurrent requests carrying the SAME Idempotency-Key race
-- on this index, not on any application-level check-then-act sequence.
--
-- =============================================================
-- SCHEMA ASSUMPTIONS (this migration has NOT been verified against any
-- real database — see the completion report's "Migration" section for the
-- full list; summarized here):
-- =============================================================
--   - public.orders already exists with an order_id text PRIMARY KEY (or
--     otherwise-unique) column — assumed from every existing INSERT in
--     pages/api/create-order.js / lib/orders/generateOrderId.js, which
--     this migration does not alter.
--   - Every EXISTING row in public.orders has NULL for both new columns
--     (they did not exist before this migration ran) — Postgres unique
--     indexes treat every NULL as distinct from every other NULL, so this
--     is compatible with the table's full existing history without a
--     backfill of any kind, whether or not the partial WHERE clause below
--     is present. The partial WHERE clause is used anyway (matching the
--     existing payments_stripe_session_id_unique_idx precedent from the
--     separate webhook engagement, for the same reason: a smaller index
--     that only exists for the rows that actually use this feature).

-- =============================================================
-- 1. orders columns (both nullable — no backfill required, no NOT NULL
--    constraint, so every historical row that predates this migration
--    remains valid with no data migration step).
-- =============================================================
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS agent_idempotency_key_hash text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS agent_idempotency_request_hash text;

-- =============================================================
-- 2. Partial unique index — the actual concurrency primitive.
-- =============================================================
-- UNIQUE + a partial WHERE clause: only rows where an Agent draft actually
-- set agent_idempotency_key_hash participate in the uniqueness check at
-- all — every pre-existing / non-Agent-created row (NULL in this column)
-- is completely unaffected, both because it is excluded by the WHERE
-- clause AND because Postgres unique indexes already never consider two
-- NULLs to conflict with each other even without a partial clause.
--
-- This is the target lib/agent/tools/createBookingDraft.js's
-- `.upsert(row, {onConflict: "agent_idempotency_key_hash", ignoreDuplicates:
-- true})` names via PostgREST's `on_conflict` parameter — PostgREST/Postgres
-- requires a real unique index or constraint matching the named column(s)
-- for ON CONFLICT to target; without this index, that upsert call would
-- fail at the database level with "there is no unique or exclusion
-- constraint matching the ON CONFLICT specification" (a real, sharp
-- failure mode if this migration were ever skipped — noted here so it is
-- never mistaken for a soft/optional index).
CREATE UNIQUE INDEX IF NOT EXISTS orders_agent_idempotency_key_hash_unique_idx
  ON public.orders (agent_idempotency_key_hash)
  WHERE agent_idempotency_key_hash IS NOT NULL;

-- Non-unique index on the request hash: NOT required for the concurrency
-- guarantee (only the key-hash index is), but makes the "read existing row
-- by key_hash, compare request_hash" follow-up lookup (the request_hash
-- comparison itself, not the row lookup, which already uses the unique
-- index above) cheap to audit/debug without a full table scan if this
-- table grows large. Optional, additive, safe to omit without affecting
-- correctness — included here as a low-cost convenience.
CREATE INDEX IF NOT EXISTS orders_agent_idempotency_request_hash_idx
  ON public.orders (agent_idempotency_request_hash)
  WHERE agent_idempotency_request_hash IS NOT NULL;

-- Explicitly NOT created: any function/RPC. This migration is pure DDL —
-- all of the actual idempotency DECISION logic (same-key-same-request vs
-- same-key-different-request vs genuinely new) lives in
-- lib/agent/tools/createBookingDraft.js on the Node side, using ordinary
-- supabase-js calls (.upsert with onConflict, then a plain .select on
-- conflict) — no new PL/pgSQL was judged necessary for A1's scope.
