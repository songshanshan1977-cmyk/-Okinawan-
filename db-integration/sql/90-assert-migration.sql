-- db-integration/sql/90-assert-migration.sql
--
-- Run AFTER: 00-bootstrap, 01-base-schema-contract, both forward
-- migrations, 02-seed. Structural assertions plus one end-to-end smoke
-- call chain. Every check RAISEs a real Postgres exception on failure, so
-- `psql -v ON_ERROR_STOP=1` aborts the whole apply-migrations.sh run with a
-- non-zero exit code — this file is a gate, not a report.
--
-- This only proves the migrations produced the DDL/behavior their own code
-- implies against the synthetic fixture in 01-base-schema-contract.sql. It
-- is POSTGRES CONTRACT FIXTURE VERIFICATION, not DB INTEGRATION VERIFIED,
-- not PRODUCTION SCHEMA VERIFIED. See db-integration/schema-assumptions.md.

-- =============================================================
-- 1. All four RPCs exist, are SECURITY DEFINER, and have the expected
--    search_path proconfig.
-- =============================================================
DO $$
DECLARE
  v_fn record;
  v_expected text[] := ARRAY[
    'process_checkout_payment_v1',
    'claim_webhook_notification_v1',
    'freeze_webhook_notification_payload_v1',
    'complete_webhook_notification_v1'
  ];
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY v_expected LOOP
    SELECT proname, prosecdef, proconfig INTO v_fn
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = v_name;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ASSERT FAILED: function public.% does not exist after migrations', v_name;
    END IF;

    IF v_fn.prosecdef IS NOT TRUE THEN
      RAISE EXCEPTION 'ASSERT FAILED: public.% is not SECURITY DEFINER (prosecdef=%)', v_name, v_fn.prosecdef;
    END IF;

    IF v_fn.proconfig IS NULL OR NOT ('search_path=pg_catalog, public' = ANY (v_fn.proconfig)) THEN
      RAISE EXCEPTION 'ASSERT FAILED: public.% proconfig does not contain search_path=pg_catalog, public (got %)', v_name, v_fn.proconfig;
    END IF;
  END LOOP;

  RAISE NOTICE 'ASSERT OK: all 4 RPCs exist, SECURITY DEFINER, search_path pinned';
END
$$;

-- =============================================================
-- 2. payments columns added by migration 1
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
    RAISE EXCEPTION 'ASSERT FAILED: expected 3 new payments columns, found %', v_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'payments_stripe_session_id_unique_idx'
  ) THEN
    RAISE EXCEPTION 'ASSERT FAILED: payments_stripe_session_id_unique_idx missing after migration 1';
  END IF;

  RAISE NOTICE 'ASSERT OK: payments columns + unique index present';
END
$$;

-- =============================================================
-- 3. send_logs columns added by migration 2 (all 16)
-- =============================================================
DO $$
DECLARE
  v_count integer;
BEGIN
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
    RAISE EXCEPTION 'ASSERT FAILED: expected 16 new send_logs columns, found %', v_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'send_logs_dedupe_key_unique_idx'
  ) THEN
    RAISE EXCEPTION 'ASSERT FAILED: send_logs_dedupe_key_unique_idx missing after migration 2';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'send_logs_claimable_idx'
  ) THEN
    RAISE EXCEPTION 'ASSERT FAILED: send_logs_claimable_idx missing after migration 2';
  END IF;

  RAISE NOTICE 'ASSERT OK: send_logs columns + both indexes present';
END
$$;

-- =============================================================
-- 4. lock_inventory_v2 placeholder untouched, still exists.
-- =============================================================
DO $$
BEGIN
  IF to_regprocedure('public.lock_inventory_v2(text)') IS NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: public.lock_inventory_v2 placeholder missing after migrations';
  END IF;
  RAISE NOTICE 'ASSERT OK: lock_inventory_v2 placeholder still present';
END
$$;

-- =============================================================
-- 5. End-to-end smoke call chain against the seeded order (ORD-SEED-0001),
--    called directly as the connecting superuser (NOT via SET ROLE
--    service_role — that ACL boundary is exercised separately and more
--    thoroughly in tests/db-integration/permissions.test.js). This only
--    proves the four RPCs are wired together correctly end to end.
-- =============================================================
DO $$
DECLARE
  v_result jsonb;
  v_claim record;
  v_freeze jsonb;
  v_complete jsonb;
  v_claimed_count integer := 0;
BEGIN
  SELECT public.process_checkout_payment_v1(
    'ORD-SEED-0001', 'cs_test_smoke_90_assert', 50000, 'cny', false
  ) INTO v_result;

  IF v_result ->> 'result' <> 'locked' THEN
    RAISE EXCEPTION 'ASSERT FAILED: smoke process_checkout_payment_v1 expected result=locked, got %', v_result;
  END IF;

  FOR v_claim IN
    SELECT * FROM public.claim_webhook_notification_v1('ORD-SEED-0001', 'cs_test_smoke_90_assert')
  LOOP
    v_claimed_count := v_claimed_count + 1;

    IF v_claim.payload_frozen_at IS NOT NULL THEN
      RAISE EXCEPTION 'ASSERT FAILED: freshly-inserted outbox row already frozen (dedupe_key=%)', v_claim.dedupe_key;
    END IF;

    SELECT public.freeze_webhook_notification_payload_v1(
      v_claim.dedupe_key, v_claim.claim_token,
      'sender@example.com', 'recipient@example.com', 'subject', '<p>html</p>',
      'webhook-' || encode(sha256(v_claim.dedupe_key::bytea), 'hex')
    ) INTO v_freeze;

    IF (v_freeze ->> 'ok')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'ASSERT FAILED: smoke freeze call failed for dedupe_key=%: %', v_claim.dedupe_key, v_freeze;
    END IF;

    SELECT public.complete_webhook_notification_v1(
      v_claim.dedupe_key, v_claim.claim_token, 'sent', 'test-provider-message-id', NULL
    ) INTO v_complete;

    IF (v_complete ->> 'ok')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'ASSERT FAILED: smoke complete call failed for dedupe_key=%: %', v_claim.dedupe_key, v_complete;
    END IF;
  END LOOP;

  -- process_checkout_payment_v1's success branch inserts exactly 2 outbox
  -- rows (customer_booking_confirmed + ops_booking_confirmed).
  IF v_claimed_count <> 2 THEN
    RAISE EXCEPTION 'ASSERT FAILED: expected to claim exactly 2 outbox rows in the smoke chain, claimed %', v_claimed_count;
  END IF;

  RAISE NOTICE 'ASSERT OK: end-to-end smoke chain (process -> claim -> freeze -> complete) succeeded, % rows', v_claimed_count;
END
$$;
