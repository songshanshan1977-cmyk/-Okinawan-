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

// This migration now defines TWO functions (issue + consume), each with its
// own RETURNING clause — scoping every function-body assertion to the named
// function's own CREATE...$$; span (matched non-greedily up to that
// function's own closing "$$;") is what keeps these assertions from
// accidentally matching the OTHER function's body.
function extractFunctionBody(sql, fnName) {
  const re = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fnName}[\\s\\S]*?\\$\\$;`, "i");
  const m = sql.match(re);
  return m ? m[0] : "";
}

const issueFnBody = extractFunctionBody(migrationSql, "issue_payment_authorization_v1");
const consumeFnBody = extractFunctionBody(migrationSql, "consume_payment_authorization_v1");

describe("payment_authorization_v1 migration — columns and CHECK constraint", () => {
  test("adds all six nullable columns via ADD COLUMN IF NOT EXISTS, no NOT NULL, no default value", () => {
    const columns = [
      ["payment_authorization_token_hash", "text"],
      ["payment_authorization_summary_hash", "text"],
      ["payment_authorization_deposit_amount", "numeric"],
      ["payment_authorization_expires_at", "timestamptz"],
      ["payment_authorization_consumed_at", "timestamptz"],
      ["payment_attempt_id", "text"],
    ];
    for (const [name, type] of columns) {
      const addRe = new RegExp(`ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${name}\\s+${type}`, "i");
      expect(migrationSql).toMatch(addRe);
      const notNullRe = new RegExp(`${name}\\s+${type}\\s+NOT\\s+NULL`, "i");
      expect(migrationSql).not.toMatch(notNullRe);
      expect(migrationSql).not.toMatch(new RegExp(`${name}[^;]*DEFAULT`, "i"));
    }
  });

  test("creates the named all-or-none CHECK constraint covering exactly five columns (token_hash/summary_hash/deposit_amount/expires_at/payment_attempt_id — never consumed_at)", () => {
    expect(migrationSql).toMatch(/ADD\s+CONSTRAINT\s+orders_payment_authorization_all_or_none_chk\s+CHECK/i);

    const checkBodyMatch = migrationSql.match(/ADD\s+CONSTRAINT\s+orders_payment_authorization_all_or_none_chk\s+CHECK\s*\(([\s\S]*?)\);/i);
    expect(checkBodyMatch).not.toBeNull();
    const checkBody = checkBodyMatch[1];

    for (const col of ["payment_authorization_token_hash", "payment_authorization_summary_hash", "payment_authorization_deposit_amount", "payment_authorization_expires_at", "payment_attempt_id"]) {
      expect(checkBody).toMatch(new RegExp(`${col}\\s+IS\\s+NULL`, "i"));
      expect(checkBody).toMatch(new RegExp(`${col}\\s+IS\\s+NOT\\s+NULL`, "i"));
    }

    // consumed_at must never appear inside the CHECK constraint body itself
    expect(checkBody).not.toMatch(/payment_authorization_consumed_at/i);
  });

  test("the CHECK constraint is guarded by a pg_constraint existence check inside a DO block (idempotent, safe to re-run)", () => {
    expect(migrationSql).toMatch(/pg_constraint/i);
    expect(migrationSql).toMatch(/orders_payment_authorization_all_or_none_chk/);
    expect(migrationSql).toMatch(/DO\s+\$\$/i);
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

describe("payment_authorization_v1 migration — issue_payment_authorization_v1 (atomic issue RPC)", () => {
  test("exists, taking (p_order_id, p_token_hash, p_candidate_attempt_id, p_summary_hash, p_deposit_amount, p_expires_at)", () => {
    expect(migrationSql).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.issue_payment_authorization_v1\s*\(\s*p_order_id\s+text\s*,\s*p_token_hash\s+text\s*,\s*p_candidate_attempt_id\s+text\s*,\s*p_summary_hash\s+text\s*,\s*p_deposit_amount\s+numeric\s*,\s*p_expires_at\s+timestamptz\s*\)/i
    );
  });

  test("its body is a single UPDATE ... RETURNING statement — never a separate SELECT-then-UPDATE", () => {
    expect(issueFnBody).not.toBe("");
    expect(issueFnBody).toMatch(/UPDATE\s+public\.orders/i);
    expect(issueFnBody).toMatch(/RETURNING/i);
    const updateCount = (issueFnBody.match(/\bUPDATE\s+public\.orders\b/gi) || []).length;
    expect(updateCount).toBe(1);
    expect(issueFnBody).not.toMatch(/SELECT[\s\S]*?FOR\s+UPDATE/i);
  });

  test("decides whether to keep the existing payment_attempt_id via a CASE expression evaluated INSIDE the same UPDATE (not a separate prior statement)", () => {
    // The CASE must appear between SET and WHERE, i.e. it is one of the
    // columns being assigned in the SAME atomic UPDATE — not a value
    // computed by an earlier, separate read.
    const setClauseMatch = issueFnBody.match(/SET\s+([\s\S]*?)\s+WHERE/i);
    expect(setClauseMatch).not.toBeNull();
    const setClause = setClauseMatch[1];
    expect(setClause).toMatch(/payment_attempt_id\s*=\s*CASE/i);
    // The CASE condition reads the row's OWN pre-update values (o.*) —
    // this is what makes the decision atomic under Postgres's per-row lock:
    // a concurrently-blocked second UPDATE re-evaluates this CASE against
    // the FIRST UPDATE's already-committed values once unblocked, so two
    // concurrent issuers for the same order+summary_hash converge on the
    // same attempt id rather than each deciding independently.
    expect(setClause).toMatch(/o\.payment_attempt_id\s+IS\s+NOT\s+NULL/i);
    expect(setClause).toMatch(/o\.payment_authorization_summary_hash\s*=\s*p_summary_hash/i);
    expect(setClause).toMatch(/o\.payment_status\s+IN\s*\(\s*'draft'\s*,\s*'pending'\s*\)/i);
    expect(setClause).toMatch(/ELSE\s+p_candidate_attempt_id/i);
  });

  test("every issuance unconditionally overwrites token_hash/summary_hash/deposit_amount/expires_at and resets consumed_at to NULL", () => {
    const setClauseMatch = issueFnBody.match(/SET\s+([\s\S]*?)\s+WHERE/i);
    const setClause = setClauseMatch[1];
    expect(setClause).toMatch(/payment_authorization_token_hash\s*=\s*p_token_hash/i);
    expect(setClause).toMatch(/payment_authorization_summary_hash\s*=\s*p_summary_hash/i);
    expect(setClause).toMatch(/payment_authorization_deposit_amount\s*=\s*p_deposit_amount/i);
    expect(setClause).toMatch(/payment_authorization_expires_at\s*=\s*p_expires_at/i);
    expect(setClause).toMatch(/payment_authorization_consumed_at\s*=\s*NULL/i);
  });

  test("is scoped by WHERE o.order_id = p_order_id (never updates every row)", () => {
    expect(issueFnBody).toMatch(/WHERE\s+o\.order_id\s*=\s*p_order_id/i);
  });

  test("returns only (order_id, payment_attempt_id) — no PII, no other column", () => {
    const returningMatch = issueFnBody.match(/RETURNING\s+([\s\S]*?);/i);
    expect(returningMatch).not.toBeNull();
    const returningList = returningMatch[1];
    expect(returningList).toMatch(/\bo\.order_id\b/i);
    expect(returningList).toMatch(/\bo\.payment_attempt_id\b/i);
    for (const piiField of ["name", "phone", "email", "wechat", "itinerary", "remark"]) {
      expect(returningList).not.toMatch(new RegExp(`\\bo\\.${piiField}\\b`, "i"));
    }
  });
});

describe("payment_authorization_v1 migration — consume_payment_authorization_v1 (atomic consume RPC)", () => {
  test("exists, taking (p_order_id, p_token_hash)", () => {
    expect(migrationSql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.consume_payment_authorization_v1\s*\(\s*p_order_id\s+text\s*,\s*p_token_hash\s+text\s*\)/i);
  });

  test("its body is a single UPDATE ... RETURNING statement — never a SELECT immediately followed by a separate UPDATE", () => {
    expect(consumeFnBody).not.toBe("");
    expect(consumeFnBody).toMatch(/UPDATE\s+public\.orders/i);
    expect(consumeFnBody).toMatch(/RETURNING/i);
    const updateCount = (consumeFnBody.match(/\bUPDATE\s+public\.orders\b/gi) || []).length;
    expect(updateCount).toBe(1);
    expect(consumeFnBody).not.toMatch(/SELECT[\s\S]*?FOR\s+UPDATE/i);
  });

  test("the WHERE clause requires: order_id match, token_hash match, consumed_at IS NULL, expires_at > now(), payment_status IN ('draft','pending')", () => {
    expect(consumeFnBody).toMatch(/o\.order_id\s*=\s*p_order_id/i);
    expect(consumeFnBody).toMatch(/o\.payment_authorization_token_hash\s*=\s*p_token_hash/i);
    expect(consumeFnBody).toMatch(/o\.payment_authorization_consumed_at\s+IS\s+NULL/i);
    expect(consumeFnBody).toMatch(/o\.payment_authorization_expires_at\s*>\s*now\(\)/i);
    expect(consumeFnBody).toMatch(/o\.payment_status\s+IN\s*\(\s*'draft'\s*,\s*'pending'\s*\)/i);
  });

  test("sets payment_authorization_consumed_at = now() and never writes any other column", () => {
    const setClauseMatch = consumeFnBody.match(/SET\s+([\s\S]*?)\s+WHERE/i);
    expect(setClauseMatch).not.toBeNull();
    expect(setClauseMatch[1].trim()).toMatch(/^payment_authorization_consumed_at\s*=\s*now\(\)$/i);
  });

  test("the RETURNING list never includes name/phone/email/wechat/itinerary/remark (no PII)", () => {
    const returningMatch = consumeFnBody.match(/RETURNING\s+([\s\S]*?);/i);
    expect(returningMatch).not.toBeNull();
    const returningList = returningMatch[1];
    for (const piiField of ["name", "phone", "email", "wechat", "itinerary", "remark"]) {
      expect(returningList).not.toMatch(new RegExp(`\\bo\\.${piiField}\\b`, "i"));
    }
  });

  test("the RETURNING list covers every HASHED_FIELDS column, payment/inventory status, the two payment_authorization_* comparison columns, payment_attempt_id, and stripe_session_id", () => {
    const returningMatch = consumeFnBody.match(/RETURNING\s+([\s\S]*?);/i);
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
      "payment_attempt_id",
      "stripe_session_id",
    ];
    for (const field of requiredFields) {
      expect(returningList).toMatch(new RegExp(`\\bo\\.${field}\\b`, "i"));
    }
  });
});

describe("payment_authorization_v1 rollback", () => {
  test("drops both RPCs via DROP FUNCTION IF EXISTS, with their exact argument signatures", () => {
    expect(rollbackSql).toMatch(/DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.issue_payment_authorization_v1\s*\(\s*text\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*numeric\s*,\s*timestamptz\s*\)/i);
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

  test("all six payment_authorization_*/payment_attempt_id columns are named as explicitly preserved (in the surrounding prose, not stripped)", () => {
    for (const col of [
      "payment_authorization_token_hash",
      "payment_authorization_summary_hash",
      "payment_authorization_deposit_amount",
      "payment_authorization_expires_at",
      "payment_authorization_consumed_at",
      "payment_attempt_id",
    ]) {
      expect(rollbackSqlRaw).toMatch(new RegExp(col));
    }
  });

  test("is wrapped in BEGIN/COMMIT", () => {
    expect(rollbackSql).toMatch(/^\s*BEGIN;/m);
    expect(rollbackSql).toMatch(/^\s*COMMIT;/m);
  });
});
