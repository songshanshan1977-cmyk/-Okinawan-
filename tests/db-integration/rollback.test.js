// tests/db-integration/rollback.test.js
//
// Phase 1 POSTGRES CONTRACT FIXTURE tests for
// supabase/rollbacks/20260722120000_webhook_fail_safe_v1_rollback.sql (the
// REAL, unmodified rollback file).
//
// Unlike the other three db-integration suites, these tests run the DROP
// FUNCTION statements for real — which would break payment-flow/outbox/
// timing tests if run against the SAME database. So every test here builds
// its own throwaway scratch database (via CREATE DATABASE / DROP DATABASE
// against the admin "postgres" database reachable from the same Postgres
// server DATABASE_URL points at), applies exactly the SQL it needs directly
// via the `pg` driver (fs.readFileSync + client.query(text) — the simple
// query protocol supports multi-statement SQL files without needing the
// psql CLI), and tears the scratch database down afterward. Nothing here
// touches the database the other three suites use.

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { hasDb, uniqueId } = require("./helpers/postgres");

const describeIfDb = hasDb() ? describe : describe.skip;

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SQL_DIR = path.join(REPO_ROOT, "db-integration", "sql");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const ROLLBACK_FILE = path.join(REPO_ROOT, "supabase", "rollbacks", "20260722120000_webhook_fail_safe_v1_rollback.sql");

function readSql(...parts) {
  return fs.readFileSync(path.join(...parts), "utf8");
}

function adminConnectionString() {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = "/postgres";
  return url.toString();
}

function dbConnectionString(dbName) {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = "/" + dbName;
  return url.toString();
}

async function createScratchDatabase() {
  const dbName = "webhook_rollback_test_" + uniqueId("db").replace(/-/g, "_");
  const admin = new Client({ connectionString: adminConnectionString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(dbName)}`);
  } finally {
    await admin.end();
  }
  return dbName;
}

async function dropScratchDatabase(dbName) {
  const admin = new Client({ connectionString: adminConnectionString() });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName]
    );
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(dbName)}`);
  } finally {
    await admin.end();
  }
}

// Runs fn(client, dbName) against a fresh scratch database, always dropping
// it afterward even if fn throws.
async function withScratchDatabase(fn) {
  const dbName = await createScratchDatabase();
  const client = new Client({ connectionString: dbConnectionString(dbName) });
  await client.connect();
  try {
    return await fn(client, dbName);
  } finally {
    await client.end();
    await dropScratchDatabase(dbName);
  }
}

async function applyBootstrapAndBaseSchema(client) {
  await client.query(readSql(SQL_DIR, "00-bootstrap-roles-extensions.sql"));
  await client.query(readSql(SQL_DIR, "01-base-schema-contract.sql"));
}

async function applyMigration1(client) {
  await client.query(readSql(MIGRATIONS_DIR, "20260722120000_webhook_fail_safe_v1.sql"));
}

async function applyMigration2(client) {
  await client.query(readSql(MIGRATIONS_DIR, "20260722130000_webhook_notification_outbox_v1.sql"));
}

async function applySeed(client) {
  await client.query(readSql(SQL_DIR, "02-seed.sql"));
}

async function applyRollback(client) {
  await client.query(readSql(ROLLBACK_FILE));
}

async function functionExists(client, regprocSignature) {
  const { rows } = await client.query(`SELECT to_regprocedure($1) IS NOT NULL AS exists`, [regprocSignature]);
  return rows[0].exists;
}

describeIfDb("rollback scenarios (D)", () => {
  jest.setTimeout(60000);

  test("1. rollback executes cleanly when all objects/both migrations exist, all 4 RPCs gone afterward", async () => {
    await withScratchDatabase(async (client) => {
      await applyBootstrapAndBaseSchema(client);
      await applyMigration1(client);
      await applyMigration2(client);
      await applySeed(client);

      await applyRollback(client);

      expect(await functionExists(client, "public.process_checkout_payment_v1(text, text, integer, text, boolean)")).toBe(false);
      expect(await functionExists(client, "public.claim_webhook_notification_v1(text, text)")).toBe(false);
      expect(await functionExists(client, "public.freeze_webhook_notification_payload_v1(text, uuid, text, text, text, text, text)")).toBe(false);
      expect(await functionExists(client, "public.complete_webhook_notification_v1(text, uuid, text, text, text)")).toBe(false);
    });
  });

  test("2. rollback executes cleanly when only migration 1 was ever applied (migration 2 never ran)", async () => {
    await withScratchDatabase(async (client) => {
      await applyBootstrapAndBaseSchema(client);
      await applyMigration1(client);
      // migration 2 deliberately skipped.

      await expect(applyRollback(client)).resolves.toBeDefined();

      expect(await functionExists(client, "public.process_checkout_payment_v1(text, text, integer, text, boolean)")).toBe(false);
      // claim/freeze/complete never existed in the first place; DROP FUNCTION IF EXISTS must not error.
      expect(await functionExists(client, "public.claim_webhook_notification_v1(text, text)")).toBe(false);
    });
  });

  test("3. rollback is safe to run twice in a row (idempotent), identical end state both times", async () => {
    await withScratchDatabase(async (client) => {
      await applyBootstrapAndBaseSchema(client);
      await applyMigration1(client);
      await applyMigration2(client);
      await applySeed(client);

      await applyRollback(client);
      await expect(applyRollback(client)).resolves.toBeDefined();

      expect(await functionExists(client, "public.process_checkout_payment_v1(text, text, integer, text, boolean)")).toBe(false);
      expect(await functionExists(client, "public.complete_webhook_notification_v1(text, uuid, text, text, text)")).toBe(false);
    });
  });

  test("4. rollback does not DROP any payments/send_logs COLUMN added by the forward migrations", async () => {
    await withScratchDatabase(async (client) => {
      await applyBootstrapAndBaseSchema(client);
      await applyMigration1(client);
      await applyMigration2(client);

      const before = await client.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name IN ('payments', 'send_logs')
         ORDER BY table_name, column_name`
      );

      await applyRollback(client);

      const after = await client.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name IN ('payments', 'send_logs')
         ORDER BY table_name, column_name`
      );

      expect(after.rows).toEqual(before.rows);
    });
  });

  test("5. rollback does not DROP any of the 3 new indexes", async () => {
    await withScratchDatabase(async (client) => {
      await applyBootstrapAndBaseSchema(client);
      await applyMigration1(client);
      await applyMigration2(client);

      const before = await client.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
         AND indexname IN ('payments_stripe_session_id_unique_idx','send_logs_dedupe_key_unique_idx','send_logs_claimable_idx')
         ORDER BY indexname`
      );
      expect(before.rows).toHaveLength(3);

      await applyRollback(client);

      const after = await client.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
         AND indexname IN ('payments_stripe_session_id_unique_idx','send_logs_dedupe_key_unique_idx','send_logs_claimable_idx')
         ORDER BY indexname`
      );
      expect(after.rows).toEqual(before.rows);
    });
  });

  test("6. rollback does not DELETE/TRUNCATE any business data row", async () => {
    await withScratchDatabase(async (client) => {
      await applyBootstrapAndBaseSchema(client);
      await applyMigration1(client);
      await applyMigration2(client);
      await applySeed(client);

      // Exercise the real success path once so payments/send_logs have real rows too.
      await client.query(
        `SELECT public.process_checkout_payment_v1($1,$2,$3,$4,$5)`,
        ["ORD-SEED-0001", "cs_test_rollback_data_check", 50000, "cny", false]
      );

      const countsBefore = await client.query(`
        SELECT
          (SELECT count(*) FROM public.orders) AS orders,
          (SELECT count(*) FROM public.payments) AS payments,
          (SELECT count(*) FROM public.inventory) AS inventory,
          (SELECT count(*) FROM public.send_logs) AS send_logs
      `);

      await applyRollback(client);

      const countsAfter = await client.query(`
        SELECT
          (SELECT count(*) FROM public.orders) AS orders,
          (SELECT count(*) FROM public.payments) AS payments,
          (SELECT count(*) FROM public.inventory) AS inventory,
          (SELECT count(*) FROM public.send_logs) AS send_logs
      `);

      expect(countsAfter.rows[0]).toEqual(countsBefore.rows[0]);
      expect(Number(countsBefore.rows[0].payments)).toBeGreaterThan(0);
      expect(Number(countsBefore.rows[0].send_logs)).toBeGreaterThan(0);
    });
  });

  test("7. lock_inventory_v2 placeholder still exists and its definition is byte-identical before/after rollback", async () => {
    await withScratchDatabase(async (client) => {
      await applyBootstrapAndBaseSchema(client);
      await applyMigration1(client);
      await applyMigration2(client);

      const before = await client.query(`SELECT pg_get_functiondef('public.lock_inventory_v2(text)'::regprocedure) AS def`);
      expect(before.rows).toHaveLength(1);

      await applyRollback(client);

      const after = await client.query(`SELECT pg_get_functiondef('public.lock_inventory_v2(text)'::regprocedure) AS def`);
      expect(after.rows[0].def).toBe(before.rows[0].def);
    });
  });
});
