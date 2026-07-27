// __tests__/agent/sql/migrationStatic.test.js
//
// A1-R1-B05: static text assertions over the actual migration/rollback SQL
// files. These files are NEVER executed against a real Postgres in this
// environment (no Docker/local Postgres/Supabase MCP available) — this is
// the only verification available for their content in this round. See
// the completion report's "真实数据库未验证事项" section for what remains
// genuinely unverified even after these checks pass.

const fs = require("fs");
const path = require("path");

const MIGRATION_PATH = path.join(__dirname, "../../../supabase/migrations/20260727090000_agent_booking_idempotency_v1.sql");
const ROLLBACK_PATH = path.join(__dirname, "../../../supabase/rollbacks/20260727090000_agent_booking_idempotency_v1_rollback.sql");

const migrationSqlRaw = fs.readFileSync(MIGRATION_PATH, "utf8");
const rollbackSqlRaw = fs.readFileSync(ROLLBACK_PATH, "utf8");

// Both files' prose comments legitimately DISCUSS the very statements
// (DROP COLUMN, DROP INDEX, the old partial-index bug) this round removes
// or explicitly avoids — e.g. "Not DROP COLUMN, not DELETE, not TRUNCATE"
// as a documented reassurance, or the file header narrating in past tense
// why the old partial index didn't work. Checking "does the phrase appear
// anywhere in the raw file" would false-positive on that prose. Every
// assertion below — both "must contain" and "must not contain" — runs
// against the comment-STRIPPED text, so it only ever sees real, executable
// SQL, never prose that happens to mention a keyword.
function stripSqlLineComments(sql) {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const migrationSql = stripSqlLineComments(migrationSqlRaw);
const rollbackSql = stripSqlLineComments(rollbackSqlRaw);

describe("agent_booking_idempotency_v1 migration — no partial unique index used as an ON CONFLICT arbiter", () => {
  test("does NOT create any partial UNIQUE INDEX on agent_idempotency_key_hash (WHERE ... IS NOT NULL)", () => {
    // The specific broken pattern this round removes: a CREATE UNIQUE INDEX
    // statement naming agent_idempotency_key_hash together with a
    // `WHERE ... IS NOT NULL` predicate. Matched loosely across whitespace/
    // newlines since the real statement spans multiple lines.
    const uniqueIndexOnKeyHashWithPartialWhere =
      /CREATE\s+UNIQUE\s+INDEX[\s\S]{0,300}agent_idempotency_key_hash[\s\S]{0,200}WHERE[\s\S]{0,100}agent_idempotency_key_hash[\s\S]{0,50}IS\s+NOT\s+NULL/i;
    expect(migrationSql).not.toMatch(uniqueIndexOnKeyHashWithPartialWhere);
  });

  test("the old partial index name no longer appears as something being CREATEd", () => {
    const createsOldIndexName = /CREATE\s+UNIQUE\s+INDEX[\s\S]{0,100}orders_agent_idempotency_key_hash_unique_idx/i;
    expect(migrationSql).not.toMatch(createsOldIndexName);
  });

  test("creates a named UNIQUE constraint via ALTER TABLE ... ADD CONSTRAINT ... UNIQUE (agent_idempotency_key_hash)", () => {
    expect(migrationSql).toMatch(/ADD\s+CONSTRAINT\s+orders_agent_idempotency_key_hash_key\s+UNIQUE\s*\(\s*agent_idempotency_key_hash\s*\)/i);
  });

  test("the named constraint is guarded by an existence check against pg_constraint inside a DO block (idempotent, safe to re-run)", () => {
    expect(migrationSql).toMatch(/pg_constraint/i);
    expect(migrationSql).toMatch(/orders_agent_idempotency_key_hash_key/);
    // Postgres has no native ADD CONSTRAINT IF NOT EXISTS syntax, so the
    // guard must appear inside a DO block.
    expect(migrationSql).toMatch(/DO\s+\$\$/i);
  });

  test("the request_hash convenience index is untouched — still a plain (non-unique) partial index, since it was never an ON CONFLICT arbiter", () => {
    expect(migrationSql).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+orders_agent_idempotency_request_hash_idx/i);
    expect(migrationSql).not.toMatch(/CREATE\s+UNIQUE\s+INDEX[\s\S]{0,100}agent_idempotency_request_hash/i);
  });

  test("still adds both nullable columns, still no NOT NULL constraint on either", () => {
    expect(migrationSql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+agent_idempotency_key_hash\s+text/i);
    expect(migrationSql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+agent_idempotency_request_hash\s+text/i);
    expect(migrationSql).not.toMatch(/agent_idempotency_key_hash\s+text\s+NOT\s+NULL/i);
    expect(migrationSql).not.toMatch(/agent_idempotency_request_hash\s+text\s+NOT\s+NULL/i);
  });
});

describe("agent_booking_idempotency_v1 rollback — DROP CONSTRAINT, not DROP INDEX, not DROP COLUMN", () => {
  test("drops the named UNIQUE constraint via ALTER TABLE ... DROP CONSTRAINT IF EXISTS", () => {
    expect(rollbackSql).toMatch(/ALTER\s+TABLE\s+public\.orders\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+orders_agent_idempotency_key_hash_key/i);
  });

  test("does NOT execute DROP INDEX at all (the old, now-removed partial-index rollback statement)", () => {
    expect(rollbackSql).not.toMatch(/DROP\s+INDEX/i);
  });

  test("never executes DROP COLUMN, DELETE FROM, or TRUNCATE anywhere in the rollback", () => {
    expect(rollbackSql).not.toMatch(/DROP\s+COLUMN/i);
    expect(rollbackSql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(rollbackSql).not.toMatch(/\bTRUNCATE\b/i);
  });

  test("both audit columns are named as explicitly preserved (in the surrounding prose, not stripped)", () => {
    expect(rollbackSqlRaw).toMatch(/agent_idempotency_key_hash/);
    expect(rollbackSqlRaw).toMatch(/agent_idempotency_request_hash/);
  });

  test("is wrapped in BEGIN/COMMIT", () => {
    expect(rollbackSql).toMatch(/^\s*BEGIN;/m);
    expect(rollbackSql).toMatch(/^\s*COMMIT;/m);
  });
});

describe("no residual claim that a partial index can serve as a plain ON CONFLICT arbiter", () => {
  test("neither file asserts a WHERE-clause index is what the upsert's onConflict targets", () => {
    // The specific wrong claim this round retracts: "(the/this) partial
    // index/unique index is the target [of|for] onConflict/ON CONFLICT".
    // Checked against the RAW (non-stripped) text on purpose — this must
    // not appear anywhere at all, prose included, since it would be a
    // false technical claim if left in the documentation even as
    // commentary.
    const wrongClaimPattern = /partial\s+(unique\s+)?index\s+is\s+the\s+(target|arbiter)/i;
    expect(migrationSqlRaw).not.toMatch(wrongClaimPattern);
    expect(rollbackSqlRaw).not.toMatch(wrongClaimPattern);
  });
});
