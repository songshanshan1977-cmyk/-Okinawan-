-- db-integration/sql/01-base-schema-contract.sql
--
-- SYNTHETIC CONTRACT FIXTURE. NOT a Supabase production schema dump.
-- See db-integration/schema-assumptions.md for the full field-by-field
-- provenance of every column below (Migration direct reference / Handler
-- SELECT reference / Structural necessity / Historical schema assumption).
--
-- Deliberately creates public.payments and public.send_logs in their
-- PRE-migration baseline shape only, so that the two real forward
-- migrations' `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements execute
-- real, meaningful DDL against this fixture rather than no-ops. See
-- schema-assumptions.md's "Pre-migration vs. post-migration baseline"
-- section for why.
--
-- public.orders and public.inventory are never ALTERed by either migration,
-- so they are created here in full.
--
-- public.lock_inventory_v2 is a SYNTHETIC PLACEHOLDER (see
-- schema-assumptions.md) — its real definition has never been read in any
-- round of this engagement and is out of scope. This placeholder exists
-- solely so 99-assert-rollback.sql can confirm the rollback script does not
-- remove it.

-- =============================================================
-- public.orders (pre-existing, unmodified by either forward migration)
-- =============================================================
CREATE TABLE public.orders (
  order_id            text PRIMARY KEY,
  start_date          date,
  end_date            date,
  car_model_id        uuid,
  driver_lang         text,
  duration            integer,
  email               text,
  name                text,
  phone               text,
  wechat              text,
  total_price         numeric,
  deposit_amount      numeric,
  balance_due         numeric,
  payment_status      text,
  inventory_status    text,
  inventory_locked    boolean NOT NULL DEFAULT false,
  status              text,
  email_customer_sent boolean NOT NULL DEFAULT false,
  email_ops_sent      boolean NOT NULL DEFAULT false
);

-- =============================================================
-- public.inventory (pre-existing, unmodified by either forward migration)
-- =============================================================
CREATE TABLE public.inventory (
  car_model_id  uuid NOT NULL,
  driver_lang   text NOT NULL,
  date          date NOT NULL,
  total_qty     integer NOT NULL DEFAULT 0,
  booked_qty    integer NOT NULL DEFAULT 0,
  locked_qty    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (car_model_id, driver_lang, date)
);

-- =============================================================
-- public.payments — PRE-migration baseline only.
-- processing_result / processing_reason / processed_at and
-- payments_stripe_session_id_unique_idx are added BY migration 1 — do not
-- create them here (see schema-assumptions.md).
-- =============================================================
CREATE TABLE public.payments (
  id                 bigserial PRIMARY KEY,
  order_id           text,
  amount             integer,
  currency           text,
  stripe_session_id  text,
  car_model_id       uuid,
  paid               boolean,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- =============================================================
-- public.send_logs — PRE-migration baseline only.
-- dedupe_key, notification_type, audience, stripe_session_id, claim_token,
-- claim_expires_at, attempt_count, sent_at, updated_at, sender_email,
-- recipient_email, email_subject, email_html, provider_idempotency_key,
-- payload_frozen_at, first_dispatch_at, send_logs_dedupe_key_unique_idx and
-- send_logs_claimable_idx are all added BY migration 2 — do not create them
-- here (see schema-assumptions.md).
-- =============================================================
CREATE TABLE public.send_logs (
  id                   bigserial PRIMARY KEY,
  order_id             text,
  email                text,
  subject              text,
  status               text NOT NULL DEFAULT 'pending',
  error_message        text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  provider_message_id  text
);

-- =============================================================
-- public.lock_inventory_v2 — SYNTHETIC PLACEHOLDER, not the real definition.
-- Exists only so 99-assert-rollback.sql can prove the rollback script never
-- touches it. Arbitrary no-op body; the real function's actual signature,
-- behavior and return type are unknown to this harness and out of scope.
-- =============================================================
CREATE OR REPLACE FUNCTION public.lock_inventory_v2(p_placeholder text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Synthetic placeholder only — see schema-assumptions.md. The real
  -- lock_inventory_v2 has never been read in any round of this engagement
  -- and this body is not a claim about what it actually does.
  RETURN;
END;
$function$;
