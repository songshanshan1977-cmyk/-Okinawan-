// __tests__/agent/sql/migrationPaymentAuthorizationStatic.test.js
//
// A3: static text assertions over the payment_authorization_v1
// migration/rollback SQL files. Never executed against a real Postgres in
// this round (no Docker/local Postgres/Supabase MCP available) — this is
// the only verification available for their content. See the completion
// report's "DB INTEGRATION UNVERIFIED" section for what remains genuinely
// unverified even after these checks pass.

const fs = require("fs");
const path = require("path");

const MIGRATION_PATH = path.join(__dirname, "../../../supabase/migrations/20260729120000_payment_authorization_v1.sql");
const ROLLBACK_PATH = path.join(__dirname, "../../../supabase/rollbacks/20260729120000_payment_authorization_v1_rollback.sql");

const migrationSqlRaw = fs.readFileSync(MIGRATION_PATH, "utf8");
const rollbackSqlRaw = fs.readFileSync(ROLLBACK_PATH, "utf8");

// Same technique as __tests__/agent/sql/migrationStatic.test.js /
// migrationConfirmationStatic.test.js: strip `--`-prefixed line comments
// before asserting "must not contain X", since the prose legitimately
// discusses statements it deliberately does NOT execute. CRLF is normalized
// to LF FIRST — see those files for why (a trailing "\r" left after a CRLF
// checkout makes JS's `.` fail to reach the newline, silently turning the
// "strip the comment" step into a no-op).
function stripSqlLineComments(sql) {
  return sql
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const migrationSql = stripSqlLineComments(migrationSqlRaw);
const rollbackSql = stripSqlLineComments(rollbackSqlRaw);

describe("payment_authorization_v1 migration", () => {
  test("adds all five nullable columns via ADD COLUMN IF NOT EXISTS, no NOT NULL, no default value", () => {
    const columns = [
      ["payment_authorization_token_hash", "text"],
      ["payment_authorization_summary_hash", "text"],
      ["payment_authorization_deposit_amount", "numeric"],
      ["payment_authorization_expires_at", "timestamptz"],
      ["payment_authorization_consumed_at", "timestamptz"],
    ];
    for (const [name, type] of columns) {
      const addRe = new RegExp(`ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${name}\\s+${type}`, "i");
      expect(migrationSql).toMatch(addRe);
      const notNullRe = new RegExp(`${name}\\s+${type}\\s+NOT\\s+NULL`, "i");
      expect(migrationSql).not.toMatch(notNullRe);
      expect(migrationSql).not.toMatch(new RegExp(`${name}[^;]*DEFAULT`, "i"));
    }
  });

  test("creates the named all-or-none CHECK constraint covering exactly the first four columns (never consumed_at)", () => {
    expect(migrationSql).toMatch(/ADD\s+CONSTRAINT\s+orders_payment_authorization_all_or_none_chk\s+CHECK/i);
    expect(migrationSql).toMatch(/payment_authorization_token_hash\s+IS\s+NULL/i);
    expect(migrationSql).toMatch(/payment_authorization_summary_hash\s+IS\s+NULL/i);
    expect(migrationSql).toMatch(/payment_authorization_deposit_amount\s+IS\s+NULL/i);
    expect(migrationSql).toMatch(/payment_authorization_expires_at\s+IS\s+NULL/i);
    expect(migrationSql).toMatch(/payment_authorization_token_hash\s+IS\s+NOT\s+NULL/i);
    expect(migrationSql).toMatch(/payment_authorization_summary_hash\s+IS\s+NOT\s+NULL/i);
    expect(migrationSql).toMatch(/payment_authorization_deposit_amount\s+IS\s+NOT\s+NULL/i);
    expect(migrationSql).toMatch(/payment_authorization_expires_at\s+IS\s+NOT\s+NULL/i);

    // consumed_at must never appear inside the CHECK constraint body itself
    const checkBodyMatch = migrationSql.match(/ADD\s+CONSTRAINT\s+orders_payment_authorization_all_or_none_chk\s+CHECK\s*\(([\s\S]*?)\);/i);
    expect(checkBodyMatch).not.toBeNull();
    expect(checkBodyMatch[1]).not.toMatch(/payment_authorization_consumed_at/i);
  });

  test("the CHECK constraint is guarded by a pg_constraint existence check inside a DO block (idempotent, safe to re-run)", () => {
    expect(migrationSql).toMatch(/pg_constraint/i);
    expect(migrationSql).toMatch(/orders_payment_authorization_all_or_none_chk/);
    expect(migrationSql).toMatch(/DO\s+\$\$/i);
  });

  test("creates the atomic consume_payment_authorization_v1 function taking (p_order_id, p_token_hash)", () => {
    expect(migrationSql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.consume_payment_authorization_v1\s*\(\s*p_order_id\s+text\s*,\s*p_token_hash\s+text\s*\)/i);
  });

  test("the function body is a single UPDATE ... RETURNING statement — never a SELECT immediately followed by a separate UPDATE", () => {
    const functionBodyMatch = migrationSql.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.consume_payment_authorization_v1[\s\S]*?\$\$\s*LANGUAGE[\s\S]*?\$\$;/i);
    // Fallback: locate the AS $$ ... $$ body directly if the above ordering differs
    const body = functionBodyMatch ? functionBodyMatch[0] : migrationSql;
    expect(body).toMatch(/UPDATE\s+public\.orders/i);
    expect(body).toMatch(/RETURNING/i);
    // Exactly one UPDATE statement inside the function body
    const updateCount = (body.match(/\bUPDATE\s+public\.orders\b/gi) || []).length;
    expect(updateCount).toBe(1);
    // No standalone SELECT ... FOR UPDATE / SELECT immediately preceding an UPDATE decision
    expect(body).not.toMatch(/SELECT[\s\S]*?FOR\s+UPDATE/i);
  });

  test("the consume function's WHERE clause requires: order_id match, token_hash match, consumed_at IS NULL, expires_at > now(), payment_status IN ('draft','pending')", () => {
    expect(migrationSql).toMatch(/o\.order_id\s*=\s*p_order_id/i);
    expect(migrationSql).toMatch(/o\.payment_authorization_token_hash\s*=\s*p_token_hash/i);
    expect(migrationSql).toMatch(/o\.payment_authorization_consumed_at\s+IS\s+NULL/i);
    expect(migrationSql).toMatch(/o\.payment_authorization_expires_at\s*>\s*now\(\)/i);
    expect(migrationSql).toMatch(/o\.payment_status\s+IN\s*\(\s*'draft'\s*,\s*'pending'\s*\)/i);
  });

  test("the consume function sets payment_authorization_consumed_at = now() and never writes any other column", () => {
    const setClauseMatch = migrationSql.match(/UPDATE\s+public\.orders\s+AS\s+o\s+SET\s+([\s\S]*?)\s+WHERE/i);
    expect(setClauseMatch).not.toBeNull();
    expect(setClauseMatch[1].trim()).toMatch(/^payment_authorization_consumed_at\s*=\s*now\(\)$/i);
  });

  test("the consume function's RETURNING list never includes name/phone/email/wechat/itinerary/remark (no PII)", () => {
    const returningMatch = migrationSql.match(/RETURNING\s+([\s\S]*?);/i);
    expect(returningMatch).not.toBeNull();
    const returningList = returningMatch[1];
    for (const piiField of ["name", "phone", "email", "wechat", "itinerary", "remark"]) {
      expect(returningList).not.toMatch(new RegExp(`\\bo\\.${piiField}\\b`, "i"));
    }
  });

  test("the consume function's RETURNING list covers every HASHED_FIELDS column plus payment/inventory status and the two payment_authorization_* comparison columns", () => {
    const returningMatch = migrationSql.match(/RETURNING\s+([\s\S]*?);/i);
    const returningList = returningMatch[1];
    const requiredFields = [
      "order_id",
      "start_date",
      "end_date",
      "car_model_id",
      "driver_lang",
      "duration",
      "pax",
      "luggage",
      "departure_hotel",
      "end_hotel",
      "total_price",
      "deposit_amount",
      "payment_status",
      "inventory_status",
      "payment_authorization_summary_hash",
      "payment_authorization_deposit_amount",
    ];
    for (const field of requiredFields) {
      expect(returningList).toMatch(new RegExp(`\\bo\\.${field}\\b`, "i"));
    }
  });

  test("does not create any index", () => {
    expect(migrationSql).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
  });

  test("never touches any other orders column, payments table, or a PII column", () => {
    expect(migrationSql).not.toMatch(/\bpublic\.payments\b/i);
    expect(migrationSql).not.toMatch(/\bagent_idempotency_key_hash\b/i); // A1 migration untouched
    expect(migrationSql).not.toMatch(/\bagent_summary_confirmed_hash\b/i); // A2 migration untouched
  });
});

describe("payment_authorization_v1 rollback", () => {
  test("drops the consume RPC via DROP FUNCTION IF EXISTS", () => {
    expect(rollbackSql).toMatch(/DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.consume_payment_authorization_v1\s*\(\s*text\s*,\s*text\s*\)/i);
  });

  test("drops the named CHECK constraint via ALTER TABLE ... DROP CONSTRAINT IF EXISTS", () => {
    expect(rollbackSql).toMatch(/ALTER\s+TABLE\s+public\.orders\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+orders_payment_authorization_all_or_none_chk/i);
  });

  test("never executes DROP COLUMN, DELETE FROM, or TRUNCATE anywhere", () => {
    expect(rollbackSql).not.toMatch(/DROP\s+COLUMN/i);
    expect(rollbackSql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(rollbackSql).not.toMatch(/\bTRUNCATE\b/i);
  });

  test("never touches the A1 idempotency or A2 confirmation migrations' constraints", () => {
    expect(rollbackSql).not.toMatch(/orders_agent_idempotency_key_hash_key/i);
    expect(rollbackSql).not.toMatch(/orders_agent_summary_confirmation_both_or_neither_chk/i);
  });

  test("all five payment_authorization_* columns are named as explicitly preserved (in the surrounding prose, not stripped)", () => {
    for (const col of [
      "payment_authorization_token_hash",
      "payment_authorization_summary_hash",
      "payment_authorization_deposit_amount",
      "payment_authorization_expires_at",
      "payment_authorization_consumed_at",
    ]) {
      expect(rollbackSqlRaw).toMatch(new RegExp(col));
    }
  });

  test("is wrapped in BEGIN/COMMIT", () => {
    expect(rollbackSql).toMatch(/^\s*BEGIN;/m);
    expect(rollbackSql).toMatch(/^\s*COMMIT;/m);
  });
});
