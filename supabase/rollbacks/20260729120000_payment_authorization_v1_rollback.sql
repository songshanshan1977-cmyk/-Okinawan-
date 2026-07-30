-- 20260729120000_payment_authorization_v1_rollback.sql
--
-- NON-DESTRUCTIVE rollback, same philosophy as every other rollback in this
-- project's history: undoes the ACTIVE DATABASE BEHAVIOR the forward
-- migration introduced, never deletes anything that could be real
-- accumulated data. DB INTEGRATION UNVERIFIED — never executed against any
-- real or local Postgres in this round.
--
-- For this migration specifically, that means:
--   - DROP both RPCs (public.issue_payment_authorization_v1 and
--     public.consume_payment_authorization_v1) — these are the only things
--     that actively ISSUE or CONSUME an authorization; dropping them stops
--     any caller from ever doing either again.
--   - DROP the named CHECK constraint
--     (orders_payment_authorization_all_or_none_chk) — the only thing that
--     actively REJECTS a hypothetical future write leaving the six columns
--     in a partial state.
--   - Do NOT drop any of the six payment_authorization_*/payment_attempt_id
--     columns. If this migration were ever actually deployed and orders had
--     already been issued/consumed an authorization, those columns are the
--     only durable record of that fact — exactly the kind of audit trail
--     this project's established convention (payments.processing_result/
--     reason, the A1 idempotency columns, the A2 confirmation columns)
--     always preserves across a rollback rather than deletes.
--
-- REQUIRED DEPLOYMENT ORDER (documented, not enforced by this file):
--   1. Roll back the Vercel deployment to a version of
--      pages/api/create-payment-intent.js / pages/api/create-order.js /
--      pages/api/agent/create-payment-link.js that does not issue or
--      consume payment authorizations (or take those endpoints offline
--      entirely).
--   2. ONLY THEN run this file. Dropping the RPCs first (while the old
--      deployment is still live) would make every payment attempt fail with
--      payment_authorization_failed / payment_session_failed instead of
--      cleanly rolling back.
--
-- Idempotent and safe to run any number of times, in any state (RPCs/
-- constraint present, already dropped, migration never applied): `DROP
-- FUNCTION IF EXISTS` / `DROP CONSTRAINT IF EXISTS` are no-ops when the
-- target doesn't exist.
--
-- Explicitly preserved (never touched by this file): every row in
-- public.orders; all six payment_authorization_*/payment_attempt_id columns
-- and any value already stored in them.

BEGIN;

-- =============================================================
-- PRE-ROLLBACK VERIFICATION (read the output before proceeding)
-- =============================================================
--   SELECT count(*) AS ever_authorized
--   FROM public.orders
--   WHERE payment_authorization_token_hash IS NOT NULL;
--   -- Informational only — confirms whether this feature has ever
--   -- actually been used. Non-zero does not block this rollback (nothing
--   -- destructive happens either way), it is just useful context.

DROP FUNCTION IF EXISTS public.issue_payment_authorization_v1(text, text, text, text, numeric, timestamptz);
DROP FUNCTION IF EXISTS public.consume_payment_authorization_v1(text, text);

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_payment_authorization_all_or_none_chk;

COMMIT;

-- =============================================================
-- POST-ROLLBACK VERIFICATION (run manually)
-- =============================================================
--   SELECT proname FROM pg_proc WHERE proname IN ('issue_payment_authorization_v1', 'consume_payment_authorization_v1');
--   -- expect: 0 rows
--
--   SELECT conname FROM pg_constraint
--   WHERE conname = 'orders_payment_authorization_all_or_none_chk'
--     AND conrelid = 'public.orders'::regclass;
--   -- expect: 0 rows
--
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'orders'
--     AND column_name IN (
--       'payment_authorization_token_hash',
--       'payment_authorization_summary_hash',
--       'payment_authorization_deposit_amount',
--       'payment_authorization_expires_at',
--       'payment_authorization_consumed_at',
--       'payment_attempt_id'
--     );
--   -- expect: 6 rows — UNCHANGED by this rollback. Not DROP COLUMN, not
--   -- DELETE, not TRUNCATE.
--
--   SELECT count(*) FROM public.orders;
--   -- expect: EXACTLY the same row count as immediately before this
--   -- rollback ran — no business or audit data was deleted.

-- =============================================================
-- Destructive cleanup (actually dropping the six columns) is
-- INTENTIONALLY NOT provided in this round, for the same reason every
-- other rollback in this project withholds column drops: if a future round
-- genuinely needs to physically remove them, that belongs in a SEPARATELY
-- named file with its own prominent warning header, never run by default.
-- No such file exists yet.
-- =============================================================
