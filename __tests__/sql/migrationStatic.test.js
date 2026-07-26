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
const FREEZE_SIGNATURE = "freeze_webhook_notification_payload_v1(text, uuid, text, text, text, text, text)";
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

  describe("R4-B01/§二: claim_webhook_notification_v1 returns payload_frozen_at + the complete frozen payload", () => {
    test("9. RETURNS TABLE includes all six frozen-state columns alongside the existing routing metadata", () => {
      const fnStart = OUTBOX_MIGRATION.indexOf("FUNCTION public.claim_webhook_notification_v1");
      const returnsStart = OUTBOX_MIGRATION.indexOf("RETURNS TABLE (", fnStart);
      const returnsEnd = OUTBOX_MIGRATION.indexOf(")", OUTBOX_MIGRATION.indexOf("provider_idempotency_key text", returnsStart));
      const returnsBlock = OUTBOX_MIGRATION.slice(returnsStart, returnsEnd);
      ["dedupe_key", "notification_type", "audience", "claim_token", "order_id"].forEach((col) =>
        expect(returnsBlock).toMatch(new RegExp(`\\b${col}\\b`))
      );
      expect(returnsBlock).toMatch(/payload_frozen_at timestamptz/);
      expect(returnsBlock).toMatch(/sender_email text/);
      expect(returnsBlock).toMatch(/recipient_email text/);
      expect(returnsBlock).toMatch(/email_subject text/);
      expect(returnsBlock).toMatch(/email_html text/);
      expect(returnsBlock).toMatch(/provider_idempotency_key text/);
    });

    test("the claim UPDATE...RETURNING captures all six frozen-state fields from the row it just claimed", () => {
      const fnStart = OUTBOX_MIGRATION.indexOf("FUNCTION public.claim_webhook_notification_v1");
      const fnEnd = OUTBOX_MIGRATION.indexOf("$function$;", fnStart);
      const body = OUTBOX_MIGRATION.slice(fnStart, fnEnd);
      expect(body).toMatch(/RETURNING\s*\n\s*payload_frozen_at, sender_email, recipient_email, email_subject, email_html, provider_idempotency_key/);
      expect(body).toMatch(/INTO\s*\n\s*v_payload_frozen_at, v_sender_email, v_recipient_email, v_email_subject, v_email_html, v_provider_idempotency_key/);
    });

    test("every claimed row's OUT parameters are assigned from the captured frozen-state locals before RETURN NEXT", () => {
      const fnStart = OUTBOX_MIGRATION.indexOf("FUNCTION public.claim_webhook_notification_v1");
      const fnEnd = OUTBOX_MIGRATION.indexOf("$function$;", fnStart);
      const body = OUTBOX_MIGRATION.slice(fnStart, fnEnd);
      const returnNextIdx = body.indexOf("RETURN NEXT;");
      const assignBlock = body.slice(0, returnNextIdx);
      expect(assignBlock).toMatch(/payload_frozen_at := v_payload_frozen_at;/);
      expect(assignBlock).toMatch(/sender_email := v_sender_email;/);
      expect(assignBlock).toMatch(/recipient_email := v_recipient_email;/);
      expect(assignBlock).toMatch(/email_subject := v_email_subject;/);
      expect(assignBlock).toMatch(/email_html := v_email_html;/);
      expect(assignBlock).toMatch(/provider_idempotency_key := v_provider_idempotency_key;/);
    });

    test("10. claim_webhook_notification_v1's signature is unchanged (text, text) — no REVOKE/GRANT/rollback update was needed for it", () => {
      expect(OUTBOX_MIGRATION).toMatch(/REVOKE ALL ON FUNCTION public\.claim_webhook_notification_v1\(text, text\) FROM PUBLIC;/);
      expect(OUTBOX_MIGRATION).toMatch(/GRANT EXECUTE ON FUNCTION public\.claim_webhook_notification_v1\(text, text\) TO service_role;/);
    });
  });

  test("R3 §一: freeze_webhook_notification_payload_v1 only writes sender_email/recipient_email/subject/html/provider_idempotency_key when payload_frozen_at IS NULL (first-writer-wins, ALL fields together)", () => {
    const freezeStart = OUTBOX_MIGRATION.indexOf("FUNCTION public.freeze_webhook_notification_payload_v1");
    const freezeEnd = OUTBOX_MIGRATION.indexOf("$function$;", freezeStart);
    const body = OUTBOX_MIGRATION.slice(freezeStart, freezeEnd);
    expect(body).toMatch(/IF v_row\.payload_frozen_at IS NULL THEN/);
    const writeBlockStart = body.indexOf("IF v_row.payload_frozen_at IS NULL THEN");
    const writeBlockEnd = body.indexOf("END IF;", writeBlockStart);
    const writeBlock = body.slice(writeBlockStart, writeBlockEnd);
    ["sender_email = p_sender_email", "recipient_email = p_recipient_email", "email_subject = p_email_subject", "email_html = p_email_html", "provider_idempotency_key = p_provider_idempotency_key"].forEach(
      (fragment) => expect(writeBlock).toContain(fragment)
    );
  });

  test("R3 §一 item 3: freeze_webhook_notification_payload_v1 rejects blank sender/recipient/subject/html/provider_idempotency_key before ever touching a row", () => {
    const freezeStart = OUTBOX_MIGRATION.indexOf("FUNCTION public.freeze_webhook_notification_payload_v1");
    const freezeEnd = OUTBOX_MIGRATION.indexOf("$function$;", freezeStart);
    const body = OUTBOX_MIGRATION.slice(freezeStart, freezeEnd);
    ["p_sender_email", "p_recipient_email", "p_email_subject", "p_email_html", "p_provider_idempotency_key"].forEach((param) => {
      expect(body).toMatch(new RegExp(`length\\(trim\\(coalesce\\(${param}, ''\\)\\)\\) = 0`));
    });
    expect(body).toMatch(/all payload fields must be non-blank/);
  });

  test("freeze_webhook_notification_payload_v1 requires the current claim_token (same ownership check as complete)", () => {
    const freezeStart = OUTBOX_MIGRATION.indexOf("FUNCTION public.freeze_webhook_notification_payload_v1");
    const freezeEnd = OUTBOX_MIGRATION.indexOf("$function$;", freezeStart);
    const body = OUTBOX_MIGRATION.slice(freezeStart, freezeEnd);
    expect(body).toMatch(/WHERE dedupe_key = p_dedupe_key\s*\n\s*AND claim_token = p_claim_token/);
  });

  test("R3 §一: freeze returns the frozen from/to/subject/html/provider_idempotency_key under a `frozen` key", () => {
    const freezeStart = OUTBOX_MIGRATION.indexOf("FUNCTION public.freeze_webhook_notification_payload_v1");
    const freezeEnd = OUTBOX_MIGRATION.indexOf("$function$;", freezeStart);
    const body = OUTBOX_MIGRATION.slice(freezeStart, freezeEnd);
    expect(body).toMatch(/'from', v_row\.sender_email/);
    expect(body).toMatch(/'to', v_row\.recipient_email/);
    expect(body).toMatch(/'subject', v_row\.email_subject/);
    expect(body).toMatch(/'html', v_row\.email_html/);
    expect(body).toMatch(/'provider_idempotency_key', v_row\.provider_idempotency_key/);
  });

  test("R3 §一: send_logs has sender_email and provider_idempotency_key columns", () => {
    expect(OUTBOX_MIGRATION).toMatch(/ALTER TABLE public\.send_logs ADD COLUMN IF NOT EXISTS sender_email text;/);
    expect(OUTBOX_MIGRATION).toMatch(/ALTER TABLE public\.send_logs ADD COLUMN IF NOT EXISTS provider_idempotency_key text;/);
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

describe("R3 §三: missing_customer_email dead-letter atomically creates an ops_missing_customer_email alert", () => {
  test("8/9. complete_webhook_notification_v1 inserts an ops_missing_customer_email row exactly when outcome='dead_letter' and error_message='missing_customer_email'", () => {
    expect(OUTBOX_MIGRATION).toMatch(
      /IF p_outcome = 'dead_letter' AND p_error_message = 'missing_customer_email' THEN/
    );
    const triggerIdx = OUTBOX_MIGRATION.indexOf("IF p_outcome = 'dead_letter' AND p_error_message = 'missing_customer_email' THEN");
    const blockEnd = OUTBOX_MIGRATION.indexOf("END IF;", triggerIdx);
    const block = OUTBOX_MIGRATION.slice(triggerIdx, blockEnd);
    expect(block).toMatch(/INSERT INTO public\.send_logs/);
    expect(block).toMatch(/'ops', 'ops_missing_customer_email'/);
    expect(block).toMatch(/ON CONFLICT \(dedupe_key\) DO NOTHING;/);
  });

  test("10. the new alert's dedupe_key includes order_id, stripe_session_id, ops, and ops_missing_customer_email", () => {
    expect(OUTBOX_MIGRATION).toMatch(
      /v_order_id \|\| ':' \|\| v_session_id \|\| ':ops:ops_missing_customer_email'/
    );
  });

  test("this insert happens in the SAME transaction as the dead_letter status UPDATE (same function body, not a separate call)", () => {
    const fnStart = OUTBOX_MIGRATION.indexOf("FUNCTION public.complete_webhook_notification_v1");
    const fnEnd = OUTBOX_MIGRATION.indexOf("$function$;", fnStart);
    const body = OUTBOX_MIGRATION.slice(fnStart, fnEnd);
    expect(body).toMatch(/status = 'dead_letter'/);
    expect(body).toMatch(/ops_missing_customer_email/);
  });

  describe("N-01/§五: the alert is gated on the ORIGINAL row genuinely being an allowed customer-audience type", () => {
    test("11/12/13. the INSERT is nested inside an IF that checks v_orig_audience = 'customer' AND v_orig_notification_type IN an allowed set, BEFORE the INSERT statement", () => {
      const triggerIdx = OUTBOX_MIGRATION.indexOf("IF p_outcome = 'dead_letter' AND p_error_message = 'missing_customer_email' THEN");
      const insertIdx = OUTBOX_MIGRATION.indexOf("INSERT INTO public.send_logs", triggerIdx);
      const gateIdx = OUTBOX_MIGRATION.indexOf("IF v_orig_audience = 'customer'", triggerIdx);
      expect(gateIdx).toBeGreaterThan(triggerIdx);
      expect(gateIdx).toBeLessThan(insertIdx);
      expect(OUTBOX_MIGRATION.slice(gateIdx, insertIdx)).toMatch(
        /AND v_orig_notification_type IN \('customer_booking_confirmed', 'customer_manual_review'\) THEN/
      );
    });

    test("14. the original row's own audience/notification_type is re-read from send_logs inside this same function call, not trusted from the caller", () => {
      const fnStart = OUTBOX_MIGRATION.indexOf("FUNCTION public.complete_webhook_notification_v1");
      const fnEnd = OUTBOX_MIGRATION.indexOf("$function$;", fnStart);
      const body = OUTBOX_MIGRATION.slice(fnStart, fnEnd);
      expect(body).toMatch(/SELECT sl\.order_id, sl\.stripe_session_id, sl\.audience, sl\.notification_type/);
      expect(body).toMatch(/INTO v_order_id, v_session_id, v_orig_audience, v_orig_notification_type/);
    });

    test("12. an ops-audience row (including ops_missing_customer_email itself) can never satisfy the gate, structurally preventing a recursive alert loop", () => {
      // The gate requires v_orig_audience = 'customer' — an ops-audience
      // row's own audience column is 'ops', which this equality can never
      // match, regardless of what error_message/outcome a caller (buggy or
      // otherwise) passes. No special-case exclusion of
      // 'ops_missing_customer_email' is needed because 'ops' != 'customer'
      // already excludes every ops-audience notification_type uniformly.
      expect(OUTBOX_MIGRATION).not.toMatch(/v_orig_audience = 'ops'/);
      expect(OUTBOX_MIGRATION).toMatch(/v_orig_audience = 'customer'/);
    });
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
  test("19/23. rollback drops all FOUR RPCs (core + claim + freeze + complete) via DROP FUNCTION IF EXISTS, with freeze's CURRENT 7-parameter signature", () => {
    expect(ROLLBACK_SQL).toMatch(/DROP FUNCTION IF EXISTS public\.process_checkout_payment_v1\(text, text, integer, text, boolean\);/);
    expect(ROLLBACK_SQL).toMatch(/DROP FUNCTION IF EXISTS public\.claim_webhook_notification_v1\(text, text\);/);
    expect(ROLLBACK_SQL).toMatch(
      /DROP FUNCTION IF EXISTS public\.freeze_webhook_notification_payload_v1\(text, uuid, text, text, text, text, text\);/
    );
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
