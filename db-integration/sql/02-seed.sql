-- db-integration/sql/02-seed.sql
--
-- Minimal baseline dataset, applied AFTER both forward migrations. Provides
-- just enough for 90-assert-migration.sql's smoke-test call chain
-- (process_checkout_payment_v1 -> claim -> freeze -> complete) to run
-- end-to-end once, and a stable, well-known car_model_id fixture the Jest
-- suites reuse (see tests/db-integration/helpers/postgres.js:
-- SEED_CAR_MODEL_ID).
--
-- Each Jest test file is responsible for inserting/cleaning up its OWN
-- additional orders/inventory/payments/send_logs rows for its specific
-- scenario (missing inventory day, zero availability, concurrent claim,
-- etc.) — those deliberately-broken or deliberately-contended states are
-- not baked into this shared seed, since different negative-path tests need
-- different, mutually incompatible starting states.

-- A recognizably-synthetic UUID, not a real car_model_id from any real
-- system — chosen to be obviously a fixture constant when it shows up in
-- test output or logs.
-- 00000000-0000-0000-0000-000000000001

INSERT INTO public.inventory (car_model_id, driver_lang, date, total_qty, booked_qty, locked_qty)
SELECT '00000000-0000-0000-0000-000000000001'::uuid, lang, d::date, 3, 0, 0
FROM generate_series('2026-09-01'::date, '2026-09-10'::date, interval '1 day') AS d
CROSS JOIN (VALUES ('ZH'), ('JP')) AS langs(lang)
ON CONFLICT (car_model_id, driver_lang, date) DO NOTHING;

INSERT INTO public.orders (
  order_id, start_date, end_date, car_model_id, driver_lang, duration,
  email, name, phone, wechat, total_price, deposit_amount, balance_due,
  payment_status, inventory_status, inventory_locked, status,
  email_customer_sent, email_ops_sent
) VALUES (
  'ORD-SEED-0001', '2026-09-01', '2026-09-01', '00000000-0000-0000-0000-000000000001'::uuid, 'ZH', 8,
  'seed-customer@example.com', 'Seed Customer', '13800000000', 'seed_wx', 1600, 500, 1100,
  'unpaid', 'pending', false, 'new',
  false, false
)
ON CONFLICT (order_id) DO NOTHING;
