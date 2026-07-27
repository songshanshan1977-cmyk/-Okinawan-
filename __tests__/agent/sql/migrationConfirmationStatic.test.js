// __tests__/agent/sql/migrationConfirmationStatic.test.js
//
// A2: static text assertions over the confirmation migration/rollback SQL
// files. Never executed against a real Postgres in this round — this is
// the only verification available for their content. See the completion
// report's "DB INTEGRATION UNVERIFIED" section for what remains genuinely
// unverified even after these checks pass.

const fs = require("fs");
const path = require("path");

const MIGRATION_PATH = path.join(__dirname, "../../../supabase/migrations/20260728100000_agent_booking_confirmation_v1.sql");
const ROLLBACK_PATH = path.join(__dirname, "../../../supabase/rollbacks/20260728100000_agent_booking_confirmation_v1_rollback.sql");

const migrationSqlRaw = fs.readFileSync(MIGRATION_PATH, "utf8");
const rollbackSqlRaw = fs.readFileSync(ROLLBACK_PATH, "utf8");

// Same technique as __tests__/agent/sql/migrationStatic.test.js: strip
// `--`-prefixed line comments before asserting "must not contain X", since
// the prose legitimately discusses statements it deliberately does NOT
// execute (e.g. "not DROP COLUMN").
function stripSqlLineComments(sql) {
  // Normalize CRLF -> LF FIRST — see __tests__/agent/sql/migrationStatic.test.js's
  // identical helper for why: without this, a file checked out with
  // Windows line endings leaves each line ending in a trailing "\r" that
  // `.` cannot consume, silently turning "strip the comment" into a no-op.
  return sql
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const migrationSql = stripSqlLineComments(migrationSqlRaw);
const rollbackSql = stripSqlLineComments(rollbackSqlRaw);

describe("agent_booking_confirmation_v1 migration", () => {
  test("adds both nullable columns via ADD COLUMN IF NOT EXISTS, no NOT NULL, no default value", () => {
    expect(migrationSql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+agent_summary_confirmed_hash\s+text/i);
    expect(migrationSql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+agent_summary_confirmed_at\s+timestamptz/i);
    expect(migrationSql).not.toMatch(/agent_summary_confirmed_hash\s+text\s+NOT\s+NULL/i);
    expect(migrationSql).not.toMatch(/agent_summary_confirmed_at\s+timestamptz\s+NOT\s+NULL/i);
  });

  test("creates the named CHECK constraint enforcing both-or-neither", () => {
    expect(migrationSql).toMatch(/ADD\s+CONSTRAINT\s+orders_agent_summary_confirmation_both_or_neither_chk\s+CHECK/i);
    expect(migrationSql).toMatch(/agent_summary_confirmed_hash\s+IS\s+NULL\s+AND\s+agent_summary_confirmed_at\s+IS\s+NULL/i);
    expect(migrationSql).toMatch(/agent_summary_confirmed_hash\s+IS\s+NOT\s+NULL\s+AND\s+agent_summary_confirmed_at\s+IS\s+NOT\s+NULL/i);
  });

  test("the CHECK constraint is guarded by a pg_constraint existence check inside a DO block (idempotent, safe to re-run)", () => {
    expect(migrationSql).toMatch(/pg_constraint/i);
    expect(migrationSql).toMatch(/DO\s+\$\$/i);
  });

  test("does not create any index at all (no current business need to look up by confirmed hash)", () => {
    expect(migrationSql).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
  });

  test("does not create any function/RPC", () => {
    expect(migrationSql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
  });

  test("never touches any other orders column, or any payments/inventory table", () => {
    expect(migrationSql).not.toMatch(/\bpublic\.payments\b/i);
    expect(migrationSql).not.toMatch(/\bpublic\.inventory\b/i);
    expect(migrationSql).not.toMatch(/\btotal_price\b/i);
    expect(migrationSql).not.toMatch(/\bdeposit_amount\b/i);
    expect(migrationSql).not.toMatch(/\bpayment_status\b/i);
    expect(migrationSql).not.toMatch(/\bagent_idempotency_key_hash\b/i); // does not touch the A1 migration's columns/constraint either
  });
});

describe("agent_booking_confirmation_v1 rollback", () => {
  test("drops the named CHECK constraint via ALTER TABLE ... DROP CONSTRAINT IF EXISTS", () => {
    expect(rollbackSql).toMatch(/ALTER\s+TABLE\s+public\.orders\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+orders_agent_summary_confirmation_both_or_neither_chk/i);
  });

  test("never executes DROP COLUMN, DELETE FROM, or TRUNCATE anywhere", () => {
    expect(rollbackSql).not.toMatch(/DROP\s+COLUMN/i);
    expect(rollbackSql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(rollbackSql).not.toMatch(/\bTRUNCATE\b/i);
  });

  test("never touches the A1 idempotency migration's constraint", () => {
    expect(rollbackSql).not.toMatch(/orders_agent_idempotency_key_hash_key/i);
  });

  test("both confirmation columns are named as explicitly preserved (in the surrounding prose, not stripped)", () => {
    expect(rollbackSqlRaw).toMatch(/agent_summary_confirmed_hash/);
    expect(rollbackSqlRaw).toMatch(/agent_summary_confirmed_at/);
  });

  test("is wrapped in BEGIN/COMMIT", () => {
    expect(rollbackSql).toMatch(/^\s*BEGIN;/m);
    expect(rollbackSql).toMatch(/^\s*COMMIT;/m);
  });
});
