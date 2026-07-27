-- 20260728100000_agent_booking_confirmation_v1_rollback.sql
--
-- NON-DESTRUCTIVE rollback, same philosophy as every other rollback in this
-- project's history: undoes the ACTIVE DATABASE BEHAVIOR the forward
-- migration introduced, never deletes anything that could be real
-- accumulated data.
--
-- For this migration specifically, that means:
--   - DROP the named CHECK constraint. This is the only "behavior" the
--     forward migration actually enforces at the database level (the two
--     columns themselves are inert storage — nothing about their mere
--     existence changes any other code path's behavior). Dropping it stops
--     the database from rejecting a hypothetical future write that sets
--     only one of the two columns; it does not touch any already-stored
--     value.
--   - Do NOT drop agent_summary_confirmed_hash / agent_summary_confirmed_at.
--     If this migration were ever actually deployed and customers had
--     already confirmed summaries, those two columns are the only durable
--     record of that fact — exactly the kind of audit trail this project's
--     established convention (payments.processing_result/reason, the A1
--     idempotency columns) always preserves across a rollback rather than
--     deletes.
--
-- REQUIRED DEPLOYMENT ORDER (documented, not enforced by this file):
--   1. Roll back the Vercel deployment to a version of
--      pages/api/agent/confirm-booking-summary.js /
--      pages/api/agent/update-booking-draft.js that does not write these
--      two columns (or take those Agent A2 endpoints offline entirely).
--   2. ONLY THEN run this file — though unlike the A1 idempotency
--      migration's unique constraint, dropping this CHECK constraint does
--      NOT make the application code start failing (a plain UPDATE
--      setting both columns, or clearing both to NULL, still succeeds
--      with no constraint at all) — the ordering requirement here is about
--      not losing the "both or neither" guarantee mid-deploy, not about
--      avoiding a hard failure.
--
-- Idempotent and safe to run any number of times, in any state (constraint
-- present, already dropped, migration never applied): `DROP CONSTRAINT IF
-- EXISTS` is a no-op when the constraint doesn't exist.
--
-- NEVER EXECUTED against any real or local Postgres in this round.
--
-- Explicitly preserved (never touched by this file): every row in
-- public.orders; agent_summary_confirmed_hash; agent_summary_confirmed_at
-- and any value already stored in them.

BEGIN;

-- =============================================================
-- PRE-ROLLBACK VERIFICATION (read the output before proceeding)
-- =============================================================
--   SELECT count(*) AS confirmed_summaries
--   FROM public.orders
--   WHERE agent_summary_confirmed_hash IS NOT NULL;
--   -- Informational only — confirms whether this feature has ever
--   -- actually been used. Non-zero does not block this rollback (nothing
--   -- destructive happens either way), it is just useful context.

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_agent_summary_confirmation_both_or_neither_chk;

COMMIT;

-- =============================================================
-- POST-ROLLBACK VERIFICATION (run manually)
-- =============================================================
--   SELECT conname FROM pg_constraint
--   WHERE conname = 'orders_agent_summary_confirmation_both_or_neither_chk'
--     AND conrelid = 'public.orders'::regclass;
--   -- expect: 0 rows
--
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'orders'
--     AND column_name IN ('agent_summary_confirmed_hash', 'agent_summary_confirmed_at');
--   -- expect: 2 rows — UNCHANGED by this rollback. Not DROP COLUMN, not
--   -- DELETE, not TRUNCATE.
--
--   SELECT count(*) FROM public.orders;
--   -- expect: EXACTLY the same row count as immediately before this
--   -- rollback ran — no business or audit data was deleted.

-- =============================================================
-- Destructive cleanup (actually dropping the two columns) is
-- INTENTIONALLY NOT provided in this round, for the same reason every
-- other rollback in this project withholds column drops: if a future round
-- genuinely needs to physically remove them, that belongs in a SEPARATELY
-- named file with its own prominent warning header, never run by default.
-- No such file exists yet.
-- =============================================================
