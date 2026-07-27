-- 20260727090000_agent_booking_idempotency_v1.sql
--
-- DRAFT — sandbox/agent-tools-v1. NOT applied to production. NEVER
-- executed against any real or local Postgres in this round (no
-- Docker/local Postgres/Supabase MCP available in this environment,
-- consistent with every other migration in this overall engagement) —
-- static text review and mocked-RPC-contract Jest tests only.
--
-- A1-R1-B05 (this revision): the FIRST version of this migration created a
-- PARTIAL unique index (`... WHERE agent_idempotency_key_hash IS NOT NULL`)
-- and claimed it could serve as the arbiter for
-- `.upsert(row, {onConflict: "agent_idempotency_key_hash", ignoreDuplicates:
-- true})`. That claim was wrong and has been removed: PostgREST's
-- `onConflict` parameter only ever passes a column list to Postgres's
-- `ON CONFLICT (columns)` inference — it has no way to also repeat a
-- partial index's WHERE predicate (Postgres's own `ON CONFLICT (columns)
-- DO NOTHING` syntax, without a WHERE clause of its own, can only infer a
-- NON-partial unique index/constraint on those exact columns; a partial
-- index is only usable as an arbiter via `ON CONFLICT (columns) WHERE
-- <same predicate> DO NOTHING`, which PostgREST has no way to emit). Left
-- as it was, the real Postgres/PostgREST call would have failed with "there
-- is no unique or exclusion constraint matching the ON CONFLICT
-- specification" the first time it actually ran — undetectable without a
-- real database, exactly the kind of gap this migration must not leave
-- undocumented.
--
-- Fix: replace the partial unique index with an ordinary, table-wide
-- UNIQUE constraint on agent_idempotency_key_hash (no WHERE clause at all).
-- PostgreSQL's UNIQUE constraints follow the SQL standard's NULL handling —
-- every NULL is considered distinct from every other NULL, including from
-- itself — so a plain (non-partial) UNIQUE constraint on a nullable column
-- already tolerates an arbitrary number of NULL rows without any special
-- partial-index treatment. Every historical order (NULL in this column,
-- since it did not exist before this migration) remains completely
-- unaffected; the constraint only ever actually fires between two rows
-- that both have the SAME non-NULL key hash, which is exactly the
-- Idempotency-Key collision this feature exists to catch. This is also now
-- correctly inferable by a plain `ON CONFLICT (agent_idempotency_key_hash)
-- DO NOTHING`, with no predicate mismatch.
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
--     (they did not exist before this migration ran) — safe under a plain
--     UNIQUE constraint precisely because Postgres never treats two NULLs
--     as equal, so no backfill of any kind is required.

-- =============================================================
-- 1. orders columns (both nullable — no backfill required, no NOT NULL
--    constraint, so every historical row that predates this migration
--    remains valid with no data migration step).
-- =============================================================
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS agent_idempotency_key_hash text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS agent_idempotency_request_hash text;

-- =============================================================
-- 2. Named UNIQUE constraint — the actual concurrency primitive, and the
--    exact arbiter lib/agent/tools/createBookingDraft.js's
--    `.upsert(row, {onConflict: "agent_idempotency_key_hash",
--    ignoreDuplicates: true})` infers.
-- =============================================================
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS` syntax, so existence is
-- checked explicitly against pg_constraint first — this keeps the
-- migration safe to run more than once, the same idempotency guarantee
-- `CREATE UNIQUE INDEX IF NOT EXISTS` gave the (now removed) partial index,
-- expressed the only way a plain ALTER TABLE ADD CONSTRAINT can be.
--
-- Deliberately NOT partial (no WHERE clause): see the file header for why
-- a partial index cannot be used as a plain `ON CONFLICT (columns) DO
-- NOTHING` arbiter, and why an ordinary UNIQUE constraint needs no partial
-- predicate to safely coexist with an arbitrary number of historical NULL
-- rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_agent_idempotency_key_hash_key'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_agent_idempotency_key_hash_key UNIQUE (agent_idempotency_key_hash);
  END IF;
END
$$;

-- Non-unique index on the request hash: unrelated to the ON CONFLICT
-- arbiter question above (it is not, and was never, a unique index, and is
-- never named in any onConflict parameter) — NOT required for the
-- concurrency guarantee (only the named UNIQUE constraint above is), but
-- makes the "read existing row by key_hash, compare request_hash"
-- follow-up lookup cheap to audit/debug without a full table scan if this
-- table grows large. Optional, additive, safe to omit without affecting
-- correctness — included here as a low-cost convenience. Kept partial
-- (WHERE ... IS NOT NULL) since a non-unique partial index has no ON
-- CONFLICT inference requirement to satisfy in the first place — the
-- A1-R1-B05 fix only concerns UNIQUE indexes/constraints used as an
-- ON CONFLICT arbiter.
CREATE INDEX IF NOT EXISTS orders_agent_idempotency_request_hash_idx
  ON public.orders (agent_idempotency_request_hash)
  WHERE agent_idempotency_request_hash IS NOT NULL;

-- Explicitly NOT created: any function/RPC. This migration is pure DDL —
-- all of the actual idempotency DECISION logic (same-key-same-request vs
-- same-key-different-request vs genuinely new) lives in
-- lib/agent/tools/createBookingDraft.js on the Node side, using ordinary
-- supabase-js calls (.upsert with onConflict, then a plain .select on
-- conflict) — no new PL/pgSQL was judged necessary for A1's scope.
