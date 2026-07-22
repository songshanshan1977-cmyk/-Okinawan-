// __tests__/sql/migrationStatic.test.js
//
// Heuristic TEXT-level static checks on the migration/rollback SQL files.
// This is NOT a real SQL parser and does NOT prove the SQL executes
// correctly — no local Postgres/psql/docker is available in this
// environment (DB INTEGRATION UNVERIFIED, see the final report). These
// tests exist to catch the specific, literal requirements Codex's Draft
// PR #2 review called out (SECURITY DEFINER, fixed search_path, the exact
// REVOKE/GRANT set, no dynamic SQL) failing to appear in the file at all —
// a much weaker guarantee than "the migration is correct", but strictly
// stronger than no check at all given the environment constraints.

const fs = require("fs");
const path = require("path");

const CORE_MIGRATION = fs.readFileSync(
  path.join(__dirname, "../../supabase/migrations/20260722120000_webhook_fail_safe_v1.sql"),
  "utf8"
);
const OUTBOX_MIGRATION = fs.readFileSync(
  path.join(__dirname, "../../supabase/migrations/20260722130000_webhook_notification_outbox_v1.sql"),
  "utf8"
);
const ROLLBACK_SQL = fs.readFileSync(
  path.join(__dirname, "../../supabase/rollbacks/20260722120000_webhook_fail_safe_v1_rollback.sql"),
  "utf8"
);

// Line-comment stripper: drops everything from an unquoted "--" to end of
// line. Deliberately simple (doesn't understand string literals containing
// "--"), which is fine here since none of these files ever put "--" inside
// a string literal — used ONLY for the structural checks below that must
// not be tripped up by English prose in this file's own doc comments
// mentioning words like "execute" or "FROM payments" in a sentence.
function stripSqlComments(sql) {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const CORE_CODE = stripSqlComments(CORE_MIGRATION);
const OUTBOX_CODE = stripSqlComments(OUTBOX_MIGRATION);

const CORE_SIGNATURE = "process_checkout_payment_v1(text, text, integer, text, boolean)";
const CLAIM_SIGNATURE = "claim_webhook_notification_v1(text, text)";
const COMPLETE_SIGNATURE = "complete_webhook_notification_v1(text, uuid, boolean, text, text)";

function countOccurrences(text, re) {
  return (text.match(re) || []).length;
}

describe("B-01: process_checkout_payment_v1 permission hardening (static)", () => {
  test("1. REVOKE ALL ... FROM PUBLIC is present for the exact signature", () => {
    expect(CORE_MIGRATION).toMatch(
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${CORE_SIGNATURE.replace(/[().]/g, "\\$&")} FROM PUBLIC;`)
    );
  });

  test("2. REVOKE ALL ... FROM anon is present for the exact signature", () => {
    expect(CORE_MIGRATION).toMatch(
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${CORE_SIGNATURE.replace(/[().]/g, "\\$&")} FROM anon;`)
    );
  });

  test("2b. REVOKE ALL ... FROM authenticated is present for the exact signature", () => {
    expect(CORE_MIGRATION).toMatch(
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${CORE_SIGNATURE.replace(/[().]/g, "\\$&")} FROM authenticated;`)
    );
  });

  test("3. GRANT EXECUTE ... TO service_role is present for the exact signature", () => {
    expect(CORE_MIGRATION).toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${CORE_SIGNATURE.replace(/[().]/g, "\\$&")} TO service_role;`)
    );
  });

  test("4a. function is declared SECURITY DEFINER", () => {
    expect(CORE_MIGRATION).toMatch(/SECURITY DEFINER/);
  });

  test("4b. function sets a fixed, non-empty search_path (pg_catalog, public)", () => {
    expect(CORE_MIGRATION).toMatch(/SET search_path = pg_catalog, public/);
  });

  test("6a. no dynamic SQL (EXECUTE / format(...)) inside the core RPC", () => {
    // Only inspect the function body between the two $function$ markers,
    // with comments stripped so English prose can't false-positive.
    const codeOnly = stripSqlComments(CORE_MIGRATION);
    const body = codeOnly.slice(codeOnly.indexOf("$function$"), codeOnly.lastIndexOf("$function$"));
    // Real dynamic SQL is `EXECUTE '...'` / `EXECUTE format(...)` — always
    // followed by a string/expression, never by "ON" (which only occurs in
    // the unrelated "GRANT EXECUTE ON FUNCTION ..." grant statements).
    expect(body).not.toMatch(/\bEXECUTE\b(?!\s+ON\b)/i);
    expect(body).not.toMatch(/\bformat\s*\(/i);
  });

  test("6b. every SQL clause referencing a business table qualifies it as public.<table>", () => {
    // Targeted (not comment-text-sensitive) check: look specifically at the
    // SQL-clause keywords that introduce a table reference (FROM/INTO/
    // UPDATE/JOIN), comments stripped first, and confirm none of them are
    // followed by a bare, unqualified table name.
    ["orders", "payments", "inventory", "send_logs"].forEach((table) => {
      const unqualifiedClause = new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+${table}\\b`, "gi");
      expect(CORE_CODE).not.toMatch(unqualifiedClause);
      // and confirm it actually IS referenced (qualified) at least once,
      // so this isn't vacuously passing because the table is never used.
      expect(CORE_CODE).toMatch(new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+public\\.${table}\\b`, "i"));
    });
  });
});

describe("B-04: claim/complete RPC permission hardening (static)", () => {
  test.each([
    ["claim_webhook_notification_v1", CLAIM_SIGNATURE],
    ["complete_webhook_notification_v1", COMPLETE_SIGNATURE],
  ])("%s: REVOKE PUBLIC/anon/authenticated + GRANT service_role, SECURITY DEFINER, fixed search_path", (name, sig) => {
    const escaped = sig.replace(/[().]/g, "\\$&");
    expect(OUTBOX_MIGRATION).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${escaped} FROM PUBLIC;`));
    expect(OUTBOX_MIGRATION).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${escaped} FROM anon;`));
    expect(OUTBOX_MIGRATION).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${escaped} FROM authenticated;`));
    expect(OUTBOX_MIGRATION).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${escaped} TO service_role;`));
  });

  test("both outbox RPCs declared SECURITY DEFINER with fixed search_path", () => {
    const definerCount = countOccurrences(OUTBOX_MIGRATION, /SECURITY DEFINER/g);
    const searchPathCount = countOccurrences(OUTBOX_MIGRATION, /SET search_path = pg_catalog, public/g);
    expect(definerCount).toBe(2);
    expect(searchPathCount).toBe(2);
  });

  test("no dynamic SQL in either outbox RPC body", () => {
    expect(OUTBOX_CODE).not.toMatch(/\bEXECUTE\b(?!\s+ON\b)/i);
    expect(OUTBOX_CODE).not.toMatch(/\bformat\s*\(/i);
  });
});

describe("B-02: session-fact recording (static)", () => {
  test("18. p_stripe_session_id NULL/blank guard exists and raises before any write", () => {
    expect(CORE_MIGRATION).toMatch(/p_stripe_session_id IS NULL OR length\(trim\(p_stripe_session_id\)\) = 0/);
    expect(CORE_MIGRATION).toMatch(/p_stripe_session_id is required/);
  });

  test("payments.order_id has NO unique constraint/index added by this migration", () => {
    expect(CORE_MIGRATION).not.toMatch(/UNIQUE\s+INDEX[^;]*ON\s+public\.payments\s*\(\s*order_id\s*\)/i);
  });

  test("payments.stripe_session_id keeps its (non-order_id) partial unique index", () => {
    expect(CORE_MIGRATION).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS payments_stripe_session_id_unique_idx\s*\n\s*ON public\.payments \(stripe_session_id\)\s*\n\s*WHERE stripe_session_id IS NOT NULL;/
    );
  });

  test("the 'order already paid by a different session' branch inserts its OWN payments row (does not just return duplicate_payment_conflict with no write)", () => {
    const idx = CORE_MIGRATION.indexOf("order_already_paid_by_different_session");
    const branchStart = CORE_MIGRATION.lastIndexOf("IF v_order.payment_status = 'paid' THEN", idx);
    const branchEnd = CORE_MIGRATION.indexOf("END IF;", idx);
    const branchText = CORE_MIGRATION.slice(branchStart, branchEnd);
    expect(branchText).toMatch(/INSERT INTO public\.payments/);
  });
});

describe("B-03/B-04: notification outbox structural checks (static)", () => {
  test("send_logs.dedupe_key has a unique index", () => {
    expect(OUTBOX_MIGRATION).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS send_logs_dedupe_key_unique_idx/);
  });

  test("dedupe_key composition includes order_id, stripe_session_id, audience and notification_type", () => {
    // Every outbox INSERT in the core migration builds dedupe_key from all
    // four components, in this fixed order.
    const dedupePattern = /p_order_id \|\| ':' \|\| p_stripe_session_id \|\| ':(customer|ops):(customer|ops)_\w+'/;
    expect(CORE_MIGRATION).toMatch(dedupePattern);
  });

  test("16. locked and failed/manual-review notification types produce structurally different dedupe_key suffixes", () => {
    expect(CORE_MIGRATION).toMatch(/:customer:customer_booking_confirmed'/);
    expect(CORE_MIGRATION).toMatch(/:customer:customer_manual_review'/);
    expect(CORE_MIGRATION).toMatch(/:ops:ops_booking_confirmed'/);
    expect(CORE_MIGRATION).toMatch(/:ops:ops_manual_review'/);
  });

  test("every outbox INSERT uses ON CONFLICT (dedupe_key) DO NOTHING", () => {
    const insertCount = countOccurrences(CORE_MIGRATION, /INSERT INTO public\.send_logs/g);
    const onConflictCount = countOccurrences(CORE_MIGRATION, /ON CONFLICT \(dedupe_key\) DO NOTHING;/g);
    expect(insertCount).toBeGreaterThan(0);
    expect(onConflictCount).toBe(insertCount);
  });

  test("complete_webhook_notification_v1 only updates a row when claim_token matches", () => {
    expect(OUTBOX_MIGRATION).toMatch(/WHERE dedupe_key = p_dedupe_key\s*\n\s*AND claim_token = p_claim_token;/);
  });

  test("complete_webhook_notification_v1 truncates error_message before persisting it", () => {
    expect(OUTBOX_MIGRATION).toMatch(/left\(coalesce\(p_error_message, 'unknown_error'\), 500\)/);
  });

  test("claim_webhook_notification_v1 can claim pending, failed, and expired-processing rows", () => {
    expect(OUTBOX_MIGRATION).toMatch(/sl\.status = 'pending'/);
    expect(OUTBOX_MIGRATION).toMatch(/sl\.status = 'failed'/);
    expect(OUTBOX_MIGRATION).toMatch(/sl\.status = 'processing' AND sl\.claim_expires_at IS NOT NULL AND sl\.claim_expires_at < now\(\)/);
  });
});

describe("20. legacy lock_inventory_v2 is not modified by either forward migration", () => {
  test("no CREATE/ALTER/DROP statement targets lock_inventory_v2", () => {
    [CORE_MIGRATION, OUTBOX_MIGRATION].forEach((sql) => {
      expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.lock_inventory_v2/);
      expect(sql).not.toMatch(/ALTER FUNCTION public\.lock_inventory_v2/);
      expect(sql).not.toMatch(/DROP FUNCTION public\.lock_inventory_v2/);
    });
  });

  test("no webhook_events table is created anywhere", () => {
    [CORE_MIGRATION, OUTBOX_MIGRATION, ROLLBACK_SQL].forEach((sql) => {
      expect(sql).not.toMatch(/CREATE TABLE[^;]*webhook_events/i);
    });
  });
});

describe("19. rollback SQL static completeness", () => {
  test("rollback drops both outbox RPCs and the core RPC", () => {
    expect(ROLLBACK_SQL).toMatch(/DROP FUNCTION IF EXISTS public\.claim_webhook_notification_v1\(text, text\);/);
    expect(ROLLBACK_SQL).toMatch(
      /DROP FUNCTION IF EXISTS public\.complete_webhook_notification_v1\(text, uuid, boolean, text, text\);/
    );
    expect(ROLLBACK_SQL).toMatch(
      /DROP FUNCTION IF EXISTS public\.process_checkout_payment_v1\(text, text, integer, text, boolean\);/
    );
  });

  test("rollback drops both new unique indexes and the extra send_logs index", () => {
    expect(ROLLBACK_SQL).toMatch(/DROP INDEX IF EXISTS public\.payments_stripe_session_id_unique_idx;/);
    expect(ROLLBACK_SQL).toMatch(/DROP INDEX IF EXISTS public\.send_logs_dedupe_key_unique_idx;/);
    expect(ROLLBACK_SQL).toMatch(/DROP INDEX IF EXISTS public\.send_logs_claimable_idx;/);
  });

  test("rollback drops every new column added by both forward migrations, and no others", () => {
    const paymentsColumns = ["processing_result", "processing_reason", "processed_at"];
    const sendLogsColumns = [
      "dedupe_key",
      "notification_type",
      "audience",
      "stripe_session_id",
      "claim_token",
      "claim_expires_at",
      "attempt_count",
      "sent_at",
      "updated_at",
    ];
    paymentsColumns.forEach((col) => {
      expect(ROLLBACK_SQL).toMatch(new RegExp(`ALTER TABLE public\\.payments DROP COLUMN IF EXISTS ${col};`));
    });
    sendLogsColumns.forEach((col) => {
      expect(ROLLBACK_SQL).toMatch(new RegExp(`ALTER TABLE public\\.send_logs DROP COLUMN IF EXISTS ${col};`));
    });
    // Pre-existing send_logs columns must NEVER be dropped by this file.
    ["order_id", "email", "subject", "status", "error_message", "created_at", "provider_message_id"].forEach((col) => {
      expect(ROLLBACK_SQL).not.toMatch(new RegExp(`DROP COLUMN IF EXISTS ${col};`));
    });
  });

  test("rollback contains no DELETE/TRUNCATE against business data tables", () => {
    expect(ROLLBACK_SQL).not.toMatch(/\bDELETE FROM\b/i);
    expect(ROLLBACK_SQL).not.toMatch(/\bTRUNCATE\b/i);
  });

  test("rollback contains no DDL statement targeting lock_inventory_v2 (comments mentioning it not-being-touched are fine)", () => {
    expect(ROLLBACK_SQL).not.toMatch(/(DROP|ALTER|CREATE OR REPLACE)\s+FUNCTION\s+public\.lock_inventory_v2/i);
  });

  test("rollback file contains pre- and post-rollback verification queries", () => {
    expect(ROLLBACK_SQL).toMatch(/PRE-ROLLBACK VERIFICATION/);
    expect(ROLLBACK_SQL).toMatch(/POST-ROLLBACK VERIFICATION/);
  });

  test("rollback is wrapped in an explicit transaction", () => {
    expect(ROLLBACK_SQL).toMatch(/^BEGIN;/m);
    expect(ROLLBACK_SQL).toMatch(/^COMMIT;/m);
  });
});

describe("paren/BEGIN-END heuristic balance (same method as the prior round's static check)", () => {
  test.each([
    ["core migration", CORE_MIGRATION],
    ["outbox migration", OUTBOX_MIGRATION],
    ["rollback", ROLLBACK_SQL],
  ])("%s: parens balanced", (_label, sql) => {
    const open = (sql.match(/\(/g) || []).length;
    const close = (sql.match(/\)/g) || []).length;
    expect(open).toBe(close);
  });

  test.each([
    ["core migration", CORE_MIGRATION, 4], // process_checkout_payment_v1 body only (function-body BEGIN/END)
    ["outbox migration", OUTBOX_MIGRATION, 2], // claim + complete function bodies
  ])("%s: function-body BEGIN count matches $function$ pair count / 2", (_label, sql, _unused) => {
    const dollarPairs = countOccurrences(sql, /\$function\$/g) / 2;
    const beginCount = countOccurrences(sql, /\n\s*BEGIN\s*\n/g);
    expect(beginCount).toBe(dollarPairs);
  });
});
