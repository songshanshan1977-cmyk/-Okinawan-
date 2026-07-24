-- db-integration/sql/99-assert-rollback.sql
--
-- Run AFTER supabase/rollbacks/20260722120000_webhook_fail_safe_v1_rollback.sql
-- has been applied. Structural, idempotent checks only — every check RAISEs
-- a real Postgres exception on failure so `psql -v ON_ERROR_STOP=1` aborts
-- apply-rollback.sh with a non-zero exit code.
--
-- Row-count invariance (rollback must not delete any business/audit data)
-- is checked separately, in db-integration/scripts/apply-rollback.sh, by
-- comparing counts captured immediately before and immediately after the
-- rollback SQL runs — that comparison needs state carried across two
-- separate psql invocations, which is bash's job here, not this file's.
--
-- This file is safe to run multiple times in a row (matches the real
-- rollback file's own idempotency guarantee) and safe to run whether both,
-- one, or neither forward migration was ever applied.

-- =============================================================
-- 1. All four RPCs no longer exist (any signature).
-- =============================================================
DO $$
BEGIN
  IF to_regprocedure('public.process_checkout_payment_v1(text, text, integer, text, boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: process_checkout_payment_v1 still exists after rollback';
  END IF;

  IF to_regprocedure('public.claim_webhook_notification_v1(text, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: claim_webhook_notification_v1 still exists after rollback';
  END IF;

  IF to_regprocedure('public.freeze_webhook_notification_payload_v1(text, uuid, text, text, text, text, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: freeze_webhook_notification_payload_v1 still exists after rollback';
  END IF;

  IF to_regprocedure('public.complete_webhook_notification_v1(text, uuid, text, text, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: complete_webhook_notification_v1 still exists after rollback';
  END IF;

  RAISE NOTICE 'ASSERT OK: all 4 RPCs no longer exist after rollback';
END
$$;

-- =============================================================
-- 2. lock_inventory_v2 placeholder untouched by rollback.
-- =============================================================
DO $$
BEGIN
  IF to_regprocedure('public.lock_inventory_v2(text)') IS NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: public.lock_inventory_v2 placeholder was removed by rollback (must be untouched)';
  END IF;
  RAISE NOTICE 'ASSERT OK: lock_inventory_v2 placeholder still present after rollback';
END
$$;

-- =============================================================
-- 3. payments/send_logs columns and indexes are NOT dropped by rollback
--    (the rollback script only DROP FUNCTIONs — it must never touch
--    columns, indexes, or data. This is the direct SQL check for that
--    non-destructiveness guarantee.)
-- =============================================================
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'payments'
    AND column_name IN ('processing_result', 'processing_reason', 'processed_at');
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'ASSERT FAILED: rollback removed payments columns (expected 3, found %)', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'send_logs'
    AND column_name IN (
      'dedupe_key','notification_type','audience','stripe_session_id',
      'claim_token','claim_expires_at','attempt_count','sent_at','updated_at',
      'sender_email','recipient_email','email_subject','email_html',
      'provider_idempotency_key','payload_frozen_at','first_dispatch_at'
    );
  IF v_count <> 16 THEN
    RAISE EXCEPTION 'ASSERT FAILED: rollback removed send_logs columns (expected 16, found %)', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname IN (
      'payments_stripe_session_id_unique_idx',
      'send_logs_dedupe_key_unique_idx',
      'send_logs_claimable_idx'
    );
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'ASSERT FAILED: rollback removed one or more indexes (expected 3, found %)', v_count;
  END IF;

  RAISE NOTICE 'ASSERT OK: payments/send_logs columns and all 3 indexes survive rollback unchanged';
END
$$;
