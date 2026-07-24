// tests/db-integration/helpers/postgres.js
//
// Shared helper for the Phase 1 Postgres contract-fixture Jest suites
// (tests/db-integration/*.test.js). Connects with the real `pg` driver
// directly to a Postgres instance named by process.env.DATABASE_URL — never
// through @supabase/supabase-js/PostgREST (Phase 1 has no PostgREST layer,
// see db-integration/README.md).
//
// Every test file in this directory must call `hasDb()` and skip its entire
// suite (describe.skip) when it is false, rather than silently reporting
// green with zero real assertions run — this environment has no local
// Postgres/Docker, so hasDb() is false here today; these suites only
// execute for real once DATABASE_URL is set by a CI job with a real
// postgres:17 service container.

const { Pool } = require("pg");

// Recognizably-synthetic UUID fixture constant, matches db-integration/sql/02-seed.sql.
const SEED_CAR_MODEL_ID = "00000000-0000-0000-0000-000000000001";
const SEED_ORDER_ID = "ORD-SEED-0001";

function hasDb() {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim().length === 0) return false;
  // Same production-URL guard as the shell scripts — belt and suspenders,
  // since Jest could in principle be invoked with a stray env var set.
  if (/supabase\.co|supabase\.in|amazonaws\.com|prod|production/i.test(url)) {
    throw new Error(
      "DATABASE_URL looks like it may point at a hosted/production database — refusing to run db-integration tests against it."
    );
  }
  return true;
}

let _pool = null;
function getPool() {
  if (!hasDb()) {
    throw new Error("getPool() called without a usable DATABASE_URL — call hasDb() first.");
  }
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return _pool;
}

async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

// Runs `fn(client)` with the Postgres session role temporarily switched via
// SET ROLE, always resetting back afterward (even on error) — used to
// exercise the REVOKE ALL / GRANT EXECUTE ... TO service_role boundary the
// migrations declare, with a REAL Postgres role, not a mock. This is a
// literal DB-ACL check; it does not simulate Supabase's PostgREST/JWT layer
// (see db-integration/README.md's "Phase 1 permission testing" note).
async function withRole(client, role, fn) {
  await client.query("SET ROLE " + client.escapeIdentifier(role));
  try {
    return await fn(client);
  } finally {
    await client.query("RESET ROLE");
  }
}

let _uniqueCounter = 0;
function uniqueId(prefix) {
  _uniqueCounter += 1;
  return `${prefix}-${process.pid}-${_uniqueCounter}`;
}

// Inserts a fresh, isolated order row for one test. Every field can be
// overridden; unset fields default to a normal "unpaid, ready to pay"
// order against the seeded inventory range (2026-09-01..2026-09-10,
// SEED_CAR_MODEL_ID, driver_lang ZH) so most tests only need to override
// the 1-2 fields their scenario actually cares about.
async function insertOrder(client, overrides = {}) {
  const row = Object.assign(
    {
      order_id: uniqueId("ORD-TEST"),
      start_date: "2026-09-01",
      end_date: "2026-09-01",
      car_model_id: SEED_CAR_MODEL_ID,
      driver_lang: "ZH",
      duration: 8,
      email: "test-customer@example.com",
      name: "Test Customer",
      phone: "13800000000",
      wechat: "test_wx",
      total_price: 1600,
      deposit_amount: 500,
      balance_due: 1100,
      payment_status: "unpaid",
      inventory_status: "pending",
      inventory_locked: false,
      status: "new",
      email_customer_sent: false,
      email_ops_sent: false,
    },
    overrides
  );

  await client.query(
    `INSERT INTO public.orders
      (order_id, start_date, end_date, car_model_id, driver_lang, duration,
       email, name, phone, wechat, total_price, deposit_amount, balance_due,
       payment_status, inventory_status, inventory_locked, status,
       email_customer_sent, email_ops_sent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      row.order_id, row.start_date, row.end_date, row.car_model_id, row.driver_lang, row.duration,
      row.email, row.name, row.phone, row.wechat, row.total_price, row.deposit_amount, row.balance_due,
      row.payment_status, row.inventory_status, row.inventory_locked, row.status,
      row.email_customer_sent, row.email_ops_sent,
    ]
  );

  return row.order_id;
}

// Inserts inventory rows for a fresh car_model_id (so a test that needs a
// SPECIFIC broken state — a missing day, zero availability — never risks
// colliding with the shared seed range or another concurrently-running
// test's rows). Returns the car_model_id used.
async function insertInventory(client, { dates, driverLang = "ZH", totalQty = 3, bookedQty = 0, lockedQty = 0, carModelId } = {}) {
  const cmId = carModelId || uniqueId("00000000-0000-0000-0000").padEnd(36, "0").slice(0, 36);
  for (const date of dates) {
    await client.query(
      `INSERT INTO public.inventory (car_model_id, driver_lang, date, total_qty, booked_qty, locked_qty)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (car_model_id, driver_lang, date) DO UPDATE
         SET total_qty = EXCLUDED.total_qty, booked_qty = EXCLUDED.booked_qty, locked_qty = EXCLUDED.locked_qty`,
      [cmId, driverLang, date, totalQty, bookedQty, lockedQty]
    );
  }
  return cmId;
}

function dateRange(startIso, endIso) {
  const out = [];
  const start = new Date(startIso + "T00:00:00Z");
  const end = new Date(endIso + "T00:00:00Z");
  for (let d = start; d <= end; d = new Date(d.getTime() + 86400000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

module.exports = {
  SEED_CAR_MODEL_ID,
  SEED_ORDER_ID,
  hasDb,
  getPool,
  closePool,
  withRole,
  uniqueId,
  insertOrder,
  insertInventory,
  dateRange,
};
