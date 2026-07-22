-- 20260722120000_webhook_fail_safe_v1_rollback.sql
--
-- Rolls back BOTH forward migrations together, in the correct dependency
-- order (outbox RPCs/columns depend on nothing from the core migration
-- being present, but the core RPC inserts into the outbox columns, so the
-- outbox objects must be dropped first):
--   20260722130000_webhook_notification_outbox_v1.sql
--   20260722120000_webhook_fail_safe_v1.sql
--
-- DB INTEGRATION UNVERIFIED: this file has been statically reviewed only
-- (paren/keyword balance, DROP/ALTER target names cross-checked against
-- the two forward migrations) — it has NOT been executed against any real
-- or local Postgres instance (none available in this environment). Do NOT
-- treat "this file exists and looks structurally sound" as "rollback has
-- been tested". Run the pre/post verification queries below by hand in a
-- staging environment before relying on this in production.
--
-- Does NOT delete any existing business data (orders/payments/inventory
-- rows are never touched by this rollback — only the NEW functions,
-- indexes, and columns these two migrations introduced are removed).
-- Does NOT modify or drop public.lock_inventory_v2.

-- =============================================================
-- 0. PRE-ROLLBACK VERIFICATION (run manually, review output first)
-- =============================================================
-- Confirm what currently depends on process_checkout_payment_v1 before
-- dropping it — e.g. is anything mid-flight relying on it right now?
--   SELECT count(*) AS rows_with_new_processing_columns
--   FROM public.payments
--   WHERE processing_result IS NOT NULL;
--
--   SELECT count(*) AS outbox_rows_still_pending_or_processing
--   FROM public.send_logs
--   WHERE status IN ('pending', 'processing');
--   -- If this is non-zero, rolling back now will strand those
--   -- notifications forever (nothing will ever claim/send them again) —
--   -- drain the outbox or accept the loss consciously before proceeding.
--
--   SELECT proname, prosecdef, proconfig
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname IN (
--       'process_checkout_payment_v1',
--       'claim_webhook_notification_v1',
--       'complete_webhook_notification_v1'
--     );

BEGIN;

-- =============================================================
-- 1. REVOKE new RPC permissions (defensive — DROP FUNCTION below already
--    removes the grants along with the function, but revoking first makes
--    the intent explicit and keeps this file safe to re-run against a
--    partially-rolled-back state).
-- =============================================================
REVOKE ALL ON FUNCTION public.claim_webhook_notification_v1(text, text) FROM service_role;
REVOKE ALL ON FUNCTION public.complete_webhook_notification_v1(text, uuid, boolean, text, text) FROM service_role;
REVOKE ALL ON FUNCTION public.process_checkout_payment_v1(text, text, integer, text, boolean) FROM service_role;

-- =============================================================
-- 2. DROP claim/complete RPCs
-- =============================================================
DROP FUNCTION IF EXISTS public.claim_webhook_notification_v1(text, text);
DROP FUNCTION IF EXISTS public.complete_webhook_notification_v1(text, uuid, boolean, text, text);

-- =============================================================
-- 3. DROP process_checkout_payment_v1
-- =============================================================
DROP FUNCTION IF EXISTS public.process_checkout_payment_v1(text, text, integer, text, boolean);

-- =============================================================
-- 4. DROP new unique indexes
-- =============================================================
DROP INDEX IF EXISTS public.payments_stripe_session_id_unique_idx;
DROP INDEX IF EXISTS public.send_logs_dedupe_key_unique_idx;

-- =============================================================
-- 5. DROP send_logs new (non-unique) index
-- =============================================================
DROP INDEX IF EXISTS public.send_logs_claimable_idx;

-- =============================================================
-- 6. DROP new columns — ONLY safe because nothing else in this codebase
--    reads them (confirmed by repo-wide grep in this same round; if that
--    has changed since, STOP and re-check before running this section).
--    Existing business data in the columns these migrations did NOT add
--    (order_id, email, subject, status, error_message, created_at,
--    provider_message_id on send_logs; every pre-existing payments column)
--    is never touched.
-- =============================================================
ALTER TABLE public.payments DROP COLUMN IF EXISTS processing_result;
ALTER TABLE public.payments DROP COLUMN IF EXISTS processing_reason;
ALTER TABLE public.payments DROP COLUMN IF EXISTS processed_at;

ALTER TABLE public.send_logs DROP COLUMN IF EXISTS dedupe_key;
ALTER TABLE public.send_logs DROP COLUMN IF EXISTS notification_type;
ALTER TABLE public.send_logs DROP COLUMN IF EXISTS audience;
ALTER TABLE public.send_logs DROP COLUMN IF EXISTS stripe_session_id;
ALTER TABLE public.send_logs DROP COLUMN IF EXISTS claim_token;
ALTER TABLE public.send_logs DROP COLUMN IF EXISTS claim_expires_at;
ALTER TABLE public.send_logs DROP COLUMN IF EXISTS attempt_count;
ALTER TABLE public.send_logs DROP COLUMN IF EXISTS sent_at;
ALTER TABLE public.send_logs DROP COLUMN IF EXISTS updated_at;

COMMIT;

-- =============================================================
-- POST-ROLLBACK VERIFICATION (run manually)
-- =============================================================
--   SELECT proname FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname IN (
--       'process_checkout_payment_v1',
--       'claim_webhook_notification_v1',
--       'complete_webhook_notification_v1'
--     );
--   -- expect: 0 rows
--
--   SELECT proname FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace AND proname = 'lock_inventory_v2';
--   -- expect: exactly 1 row, unchanged — confirms this rollback did not
--   -- touch the legacy function.
--
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'payments'
--     AND column_name IN ('processing_result', 'processing_reason', 'processed_at');
--   -- expect: 0 rows
--
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'send_logs'
--     AND column_name IN ('dedupe_key','notification_type','audience','stripe_session_id',
--                          'claim_token','claim_expires_at','attempt_count','sent_at','updated_at');
--   -- expect: 0 rows
--
--   SELECT count(*) FROM public.orders;
--   SELECT count(*) FROM public.payments;
--   SELECT count(*) FROM public.inventory;
--   -- expect: same row counts as immediately before rollback — no business
--   -- data was deleted by this file.
