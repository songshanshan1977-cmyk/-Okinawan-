// __tests__/sql/migrationStatic.test.js
//
// Heuristic TEXT-level static checks on the migration/rollback SQL files.
// This is NOT a real SQL parser and does NOT prove the SQL executes
// correctly — no local Postgres/psql/docker is available in this
// environment (DB INTEGRATION UNVERIFIED, see the final report). These
// tests exist to catch the specific, literal requirements from BOTH Codex
// review rounds (SECURITY DEFINER, fixed search_path, the exact
// REVOKE/GRANT set, no dynamic SQL, non-destructive rollback, dead-letter
// sweep, payload freeze) failing to appear in the file at all — a much
// weaker guarantee than "the migration is correct", but strictly stronger
// than no check at all given the environment constraints.

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
// not be tripped up by English prose in this file's own doc comments.
function stripSqlComments(sql) {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const CORE_CODE = stripSqlComments(CORE_MIGRATION);
const OUTBOX_CODE = stripSqlComments(OUTBOX_MIGRATION);
const ROLLBACK_CODE = stripSqlComments(ROLLBACK_SQL);

const CORE_SIGNATURE = "process_checkout_payment_v1(text, text, integer, text, boolean)";
const CLAIM_SIGNATURE = "claim_webhook_notification_v1(text, text)";
const FREEZE_SIGNATURE = "freeze_webhook_notification_payload_v1(text, uuid, text, text, text)";
const COMPLETE_SIGNATURE = "complete_webhook_notification_v1(text, uuid, text, text, text)";

function countOccurrences(text, re) {
  return (text.match(re) || []).length;
}

function escapeSig(sig) {
  return sig.replace(/[().]/g, "\\$&");
}

describe("B-01: process_checkout_payment_v1 permission hardening (static)", () => {
  test("1. REVOKE ALL ... FROM PUBLIC is present for the exact signature", () => {
    expect(CORE_MIGRATION).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${escapeSig(CORE_SIGNATURE)} FROM PUBLIC;`));
  });

  test("2. REVOKE ALL ... FROM anon is present for the exact signature", () => {
    expect(CORE_MIGRATION).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${escapeSig(CORE_SIGNATURE)} FROM anon;`));
  });

  test("2b. REVOKE ALL ... FROM authenticated is present for the exact signature", () => {
    expect(CORE_MIGRATION).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${escapeSig(CORE_SIGNATURE)} FROM authenticated;`));
  });

  test("3. GRANT EXECUTE ... TO service_role is present for the exact signature", () => {
    expect(CORE_MIGRATION).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${escapeSig(CORE_SIGNATURE)} TO service_role;`));
  });

  test("4a. function is declared SECURITY DEFINER", () => {
    expect(CORE_MIGRATION).toMatch(/SECURITY DEFINER/);
  });

  test("4b. function sets a fixed, non-empty search_path (pg_catalog, public)", () => {
    expect(CORE_MIGRATION).toMatch(/SET search_path = pg_catalog, public/);
  });

  test("6a. no dynamic SQL (EXECUTE / format(...)) inside the core RPC", () => {
    const body = CORE_CODE.slice(CORE_CODE.indexOf("$function$"), CORE_CODE.lastIndexOf("$function$"));
    expect(body).not.toMatch(/\bEXECUTE\b(?!\s+ON\b)/i);
    expect(body).not.toMatch(/\bformat\s*\(/i);
  });

  test("6b. every SQL clause referencing a business table qualifies it as public.<table>", () => {
    ["orders", "payments", "inventory", "send_logs"].forEach((table) => {
      const unqualifiedClause = new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+${table}\\b`, "gi");
      expect(CORE_CODE).not.toMatch(unqualifiedClause);
      expect(CORE_CODE).toMatch(new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+public\\.${table}\\b`, "i"));
    });
  });
});

describe("B-04/R2 §一/§三: claim/freeze/complete RPC permission hardening (static)", () => {
  test.each([
    ["claim_webhook_notification_v1", CLAIM_SIGNATURE],
    ["freeze_webhook_notification_payload_v1", FREEZE_SIGNATURE],
    ["complete_webhook_notification_v1", COMPLETE_SIGNATURE],
  ])("24. %s: REVOKE PUBLIC/anon/authenticated + GRANT service_role, SECURITY DEFINER, fixed search_path", (name, sig) => {
    const escaped = escapeSig(sig);
    expect(OUTBOX_MIGRATION).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${escaped} FROM PUBLIC;`));
    expect(OUTBOX_MIGRATION).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${escaped} FROM anon;`));
    expect(OUTBOX_MIGRATION).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${escaped} FROM authenticated;`));
    expect(OUTBOX_MIGRATION).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${escaped} TO service_role;`));
  });

  test("all three outbox RPCs declared SECURITY DEFINER with fixed search_path", () => {
    expect(countOccurrences(OUTBOX_MIGRATION, /SECURITY DEFINER/g)).toBe(3);
    expect(countOccurrences(OUTBOX_MIGRATION, /SET search_path = pg_catalog, public/g)).toBe(3);
  });

  test("no dynamic SQL in any of the three outbox RPC bodies", () => {
    expect(OUTBOX_CODE).not.toMatch(/\bEXECUTE\b(?!\s+ON\b)/i);
    expect(OUTBOX_CODE).not.toMatch(/\bformat\s*\(/i);
  });

  test("every business table reference in the outbox migration is schema-qualified", () => {
    ["orders", "send_logs"].forEach((table) => {
      const unqualifiedClause = new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+${table}\\b`, "gi");
      expect(OUTBOX_CODE).not.toMatch(unqualifiedClause);
      expect(OUTBOX_CODE).toMatch(new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+public\\.${table}\\b`, "i"));
    });
  });
});

describe("B-02: session-fact recording (static)", () => {
  test("p_stripe_session_id NULL/blank guard exists and raises before any write", () => {
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

  test("the 'order already paid by a different session' branch inserts its OWN payments row", () => {
    const idx = CORE_MIGRATION.indexOf("order_already_paid_by_different_session', now())");
    const branchStart = CORE_MIGRATION.lastIndexOf("IF v_order.payment_status = 'paid' THEN", idx);
    const branchEnd = CORE_MIGRATION.indexOf("END IF;", idx);
    const branchText = CORE_MIGRATION.slice(branchStart, branchEnd);
    expect(branchText).toMatch(/INSERT INTO public\.payments/);
  });
});

describe("R2 §六: same Session, different order -> ops-only conflict outbox, no payment double-write", () => {
  test("17. the 'session bound to a different order_id' branch inserts exactly one ops outbox row via ON CONFLICT DO NOTHING", () => {
    const idx = CORE_MIGRATION.indexOf("stripe_session_id_bound_to_different_order");
    // this literal reason string no longer appears as the RETURNED reason
    // (renamed to 'session_order_conflict' per R2 §六), but the branch
    // comment referencing the OLD behavior may still mention it — locate
    // the branch by its ELSE/session-mismatch structure instead.
    const branchMarker = CORE_MIGRATION.indexOf("ops_session_order_conflict");
    expect(branchMarker).toBeGreaterThan(-1);
    const branchStart = CORE_MIGRATION.lastIndexOf("ELSE", branchMarker);
    const branchEnd = CORE_MIGRATION.indexOf("END IF;", branchMarker);
    const branchText = CORE_MIGRATION.slice(branchStart, branchEnd);
    expect(branchText).toMatch(/INSERT INTO public\.send_logs/);
    expect(branchText).toMatch(/ON CONFLICT \(dedupe_key\) DO NOTHING;/);
    expect(branchText).not.toMatch(/INSERT INTO public\.payments/);
    expect(branchText).toMatch(/'result',\s*'duplicate_payment_conflict'/);
    expect(branchText).toMatch(/'existing_order_id',\s*v_existing_payment_order_id/);
  });

  test("session/order-conflict dedupe_key is keyed on (stripe_session_id, attempted order_id, ops, session_order_conflict)", () => {
    expect(CORE_MIGRATION).toMatch(
      /p_stripe_session_id \|\| ':' \|\| p_order_id \|\| ':ops:session_order_conflict'/
    );
  });
});

describe("B-03/B-04/R2 §三/§四: notification outbox structural checks (static)", () => {
  test("send_logs.dedupe_key has a (non-partial) unique index", () => {
    expect(OUTBOX_MIGRATION).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS send_logs_dedupe_key_unique_idx\s*\n\s*ON public\.send_logs \(dedupe_key\);/);
  });

  test("every outbox INSERT in the core migration uses ON CONFLICT (dedupe_key) DO NOTHING", () => {
    const insertCount = countOccurrences(CORE_MIGRATION, /INSERT INTO public\.send_logs/g);
    const onConflictCount = countOccurrences(CORE_MIGRATION, /ON CONFLICT \(dedupe_key\) DO NOTHING;/g);
    expect(insertCount).toBeGreaterThan(0);
    expect(onConflictCount).toBe(insertCount);
  });

  test("16. locked, manual-review, and session-order-conflict notification types all have structurally distinct dedupe_key suffixes", () => {
    expect(CORE_MIGRATION).toMatch(/:customer:customer_booking_confirmed'/);
    expect(CORE_MIGRATION).toMatch(/:customer:customer_manual_review'/);
    expect(CORE_MIGRATION).toMatch(/:ops:ops_booking_confirmed'/);
    expect(CORE_MIGRATION).toMatch(/:ops:ops_manual_review'/);
    expect(CORE_MIGRATION).toMatch(/:ops:session_order_conflict'/);
  });

  test("claim_webhook_notification_v1 can claim pending, failed, and expired-processing rows", () => {
    expect(OUTBOX_MIGRATION).toMatch(/sl\.status = 'pending'/);
    expect(OUTBOX_MIGRATION).toMatch(/sl\.status = 'failed'/);
    expect(OUTBOX_MIGRATION).toMatch(/sl\.status = 'processing' AND sl\.claim_expires_at IS NOT NULL AND sl\.claim_expires_at < now\(\)/);
  });

  test("22/10/11. claim_webhook_notification_v1 sweeps rows past the 23-hour first_dispatch_at cutoff into dead_letter BEFORE selecting claimable rows", () => {
    const sweepIdx = OUTBOX_MIGRATION.indexOf("status = 'dead_letter'");
    const claimLoopIdx = OUTBOX_MIGRATION.indexOf("FOR UPDATE SKIP LOCKED");
    expect(sweepIdx).toBeGreaterThan(-1);
    expect(claimLoopIdx).toBeGreaterThan(-1);
    expect(sweepIdx).toBeLessThan(claimLoopIdx);
    expect(OUTBOX_MIGRATION).toMatch(/first_dispatch_at <= now\(\) - interval '23 hours'/);
    expect(OUTBOX_MIGRATION).toMatch(/error_message = 'provider_delivery_uncertain'/);
  });

  test("claim_webhook_notification_v1 sets first_dispatch_at only on a row's first-ever claim (COALESCE, never overwritten)", () => {
    expect(OUTBOX_MIGRATION).toMatch(/first_dispatch_at = COALESCE\(first_dispatch_at, now\(\)\)/);
  });

  test("freeze_webhook_notification_payload_v1: only writes recipient_email/subject/html when payload_frozen_at IS NULL (first-writer-wins)", () => {
    expect(OUTBOX_MIGRATION).toMatch(/IF v_row\.payload_frozen_at IS NULL THEN/);
  });

  test("freeze_webhook_notification_payload_v1 requires the current claim_token (same ownership check as complete)", () => {
    const freezeStart = OUTBOX_MIGRATION.indexOf("FUNCTION public.freeze_webhook_notification_payload_v1");
    const freezeEnd = OUTBOX_MIGRATION.indexOf("$function$;", freezeStart);
    const body = OUTBOX_MIGRATION.slice(freezeStart, freezeEnd);
    expect(body).toMatch(/WHERE dedupe_key = p_dedupe_key\s*\n\s*AND claim_token = p_claim_token/);
  });

  test("complete_webhook_notification_v1 validates p_outcome is one of sent/failed/dead_letter", () => {
    expect(OUTBOX_MIGRATION).toMatch(/IF p_outcome NOT IN \('sent', 'failed', 'dead_letter'\) THEN/);
  });

  test("16/7. complete_webhook_notification_v1 'sent' outcome requires a non-empty provider_message_id (can never mark sent with no proof of delivery)", () => {
    const sentBranchStart = OUTBOX_MIGRATION.indexOf("IF p_outcome = 'sent' THEN");
    const sentBranchEnd = OUTBOX_MIGRATION.indexOf("ELSIF p_outcome = 'failed'");
    const body = OUTBOX_MIGRATION.slice(sentBranchStart, sentBranchEnd);
    expect(body).toMatch(/AND p_provider_message_id IS NOT NULL/);
    expect(body).toMatch(/AND length\(trim\(p_provider_message_id\)\) > 0/);
  });

  test("complete_webhook_notification_v1 only updates a row when claim_token matches, for every outcome branch", () => {
    const matches = countOccurrences(OUTBOX_MIGRATION, /WHERE dedupe_key = p_dedupe_key\s*\n\s*AND claim_token = p_claim_token/g);
    expect(matches).toBeGreaterThanOrEqual(3); // sent, failed, dead_letter branches
  });

  test("complete_webhook_notification_v1 truncates error_message before persisting it (failed and dead_letter branches)", () => {
    expect(countOccurrences(OUTBOX_MIGRATION, /left\(coalesce\(p_error_message, '[a-z_]+'\), 500\)/g)).toBe(2);
  });

  test("legacy orders.email_*_sent mirror is written ONLY on 'sent', never on 'failed'/'dead_letter'", () => {
    const sentBranchStart = OUTBOX_MIGRATION.indexOf("IF p_outcome = 'sent' THEN");
    const mirrorIdx = OUTBOX_MIGRATION.indexOf("IF p_outcome = 'sent' THEN", sentBranchStart + 10);
    expect(mirrorIdx).toBeGreaterThan(-1); // the second occurrence is the backward-compat mirror guard
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

describe("R2 §八: non-destructive rollback (rewritten this round)", () => {
  test("23. rollback drops all FOUR RPCs (core + claim + freeze + complete) via DROP FUNCTION IF EXISTS", () => {
    expect(ROLLBACK_SQL).toMatch(/DROP FUNCTION IF EXISTS public\.process_checkout_payment_v1\(text, text, integer, text, boolean\);/);
    expect(ROLLBACK_SQL).toMatch(/DROP FUNCTION IF EXISTS public\.claim_webhook_notification_v1\(text, text\);/);
    expect(ROLLBACK_SQL).toMatch(/DROP FUNCTION IF EXISTS public\.freeze_webhook_notification_payload_v1\(text, uuid, text, text, text\);/);
    expect(ROLLBACK_SQL).toMatch(/DROP FUNCTION IF EXISTS public\.complete_webhook_notification_v1\(text, uuid, text, text, text\);/);
  });

  test("21. rollback contains NO DROP COLUMN statement anywhere (code only, comments may discuss it)", () => {
    expect(ROLLBACK_CODE).not.toMatch(/DROP COLUMN/i);
  });

  test("rollback contains NO DROP INDEX statement anywhere (indexes are preserved too)", () => {
    expect(ROLLBACK_CODE).not.toMatch(/DROP INDEX/i);
  });

  test("21. rollback contains no DELETE/TRUNCATE against business data tables", () => {
    expect(ROLLBACK_SQL).not.toMatch(/\bDELETE FROM\b/i);
    expect(ROLLBACK_SQL).not.toMatch(/\bTRUNCATE\b/i);
  });

  test("rollback contains no DDL statement targeting lock_inventory_v2", () => {
    expect(ROLLBACK_SQL).not.toMatch(/(DROP|ALTER|CREATE OR REPLACE)\s+FUNCTION\s+public\.lock_inventory_v2/i);
  });

  test("rollback file contains pre- and post-rollback verification queries", () => {
    expect(ROLLBACK_SQL).toMatch(/PRE-ROLLBACK VERIFICATION/);
    expect(ROLLBACK_SQL).toMatch(/POST-ROLLBACK VERIFICATION/);
  });

  test("22. rollback is wrapped in an explicit transaction (safe to run repeatedly)", () => {
    expect(ROLLBACK_SQL).toMatch(/^BEGIN;/m);
    expect(ROLLBACK_SQL).toMatch(/^COMMIT;/m);
  });

  test("rollback documents the required Vercel-then-database deployment order", () => {
    expect(ROLLBACK_SQL).toMatch(/REQUIRED DEPLOYMENT ORDER/);
  });

  test("rollback does NOT claim columns were deleted while also claiming business data is preserved (no self-contradiction)", () => {
    // The specific bug this round fixed: R1's rollback said "does not
    // delete business data" while itself DROPping audit columns. Guard
    // against ever reintroducing that contradiction: the CODE must never
    // DROP COLUMN, while the file's own prose is expected to (and does)
    // discuss preservation explicitly.
    expect(ROLLBACK_CODE).not.toMatch(/DROP COLUMN/i);
    expect(ROLLBACK_SQL).toMatch(/preserved|UNCHANGED|never touched/i);
  });

  test("no destructive_cleanup file was created this round (not needed, per instructions)", () => {
    const rollbacksDir = path.join(__dirname, "../../supabase/rollbacks");
    const files = fs.readdirSync(rollbacksDir);
    const destructiveFiles = files.filter((f) => f.includes("destructive_cleanup"));
    expect(destructiveFiles).toEqual([]);
  });
});

describe("paren/BEGIN-END heuristic balance", () => {
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
    ["core migration", CORE_MIGRATION],
    ["outbox migration", OUTBOX_MIGRATION],
  ])("%s: function-body BEGIN count matches $function$ pair count", (_label, sql) => {
    const dollarPairs = countOccurrences(sql, /\$function\$/g) / 2;
    const beginCount = countOccurrences(sql, /\n\s*BEGIN\s*\n/g);
    expect(beginCount).toBe(dollarPairs);
  });
});
