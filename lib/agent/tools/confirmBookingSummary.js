// lib/agent/tools/confirmBookingSummary.js
//
// Agent tool: confirm_booking_summary (A2). Persists the fact that the
// customer has explicitly seen and agreed to a SPECIFIC summary_hash — the
// one durable fact A3 will need before it may ever generate a one-time
// payment link (A3 itself is out of scope here; this tool only writes the
// confirmation record, it never touches Stripe or payment status).
//
// This tool NEVER: modifies any business/booking field, recomputes price,
// touches payment_status/inventory_status, calls Stripe, or returns any
// PII. A browser redirect is never treated as confirmation — the ONLY
// thing that counts is the customer explicitly agreeing to a specific
// hash, which the Agent then submits here.
//
// Reuses lib/agent/bookingSummary.js for the read whitelist and hash
// algorithm — the exact same one get_booking_summary and
// update_booking_draft use. No second Hash implementation.

const { SUMMARY_COLUMNS, computeSummaryHash, isOrderEditable } = require("../bookingSummary");
const { AGENT_ERROR_CODES } = require("../errorCodes");

// SUMMARY_COLUMNS plus the two confirmation columns this tool specifically
// needs to read to decide idempotent-replay vs first-time-write vs
// conflicting-hash. Still a fixed whitelist — never select('*') — just one
// that is a superset of the shared display whitelist for this tool's own
// internal decision-making (these two extra columns are never returned to
// the caller directly; the response is built explicitly, field by field).
const CONFIRMATION_LOOKUP_COLUMNS = [...SUMMARY_COLUMNS, "agent_summary_confirmed_hash", "agent_summary_confirmed_at"];

/**
 * @param {object} params
 * @param {object} params.supabase
 * @param {string} params.order_id
 * @param {string} params.summary_hash - the hash the customer just saw and explicitly agreed to
 * @returns {Promise<{ok:true, confirmed:true, order_id:string, summary_hash:string, confirmed_at:string} | {ok:false, code:string}>}
 */
async function confirmBookingSummaryTool({ supabase, order_id, summary_hash }) {
  if (!order_id || typeof order_id !== "string") {
    return { ok: false, code: AGENT_ERROR_CODES.INVALID_REQUEST };
  }
  if (!summary_hash || typeof summary_hash !== "string") {
    return { ok: false, code: AGENT_ERROR_CODES.INVALID_REQUEST };
  }

  const { data: order, error: readErr } = await supabase
    .from("orders")
    .select(CONFIRMATION_LOOKUP_COLUMNS.join(", "))
    .eq("order_id", order_id)
    .maybeSingle();

  if (readErr) {
    return { ok: false, code: AGENT_ERROR_CODES.CONFIRMATION_FAILED };
  }
  if (!order) {
    return { ok: false, code: AGENT_ERROR_CODES.ORDER_NOT_FOUND };
  }
  if (!isOrderEditable(order.payment_status)) {
    return { ok: false, code: AGENT_ERROR_CODES.PAID_ORDER_IMMUTABLE };
  }

  const liveHash = computeSummaryHash(order);
  if (summary_hash !== liveHash) {
    return { ok: false, code: AGENT_ERROR_CODES.SUMMARY_STALE };
  }

  // Idempotent replay: this exact hash is already the confirmed one — do
  // not re-write updated_at/confirmed_at, just hand back the original.
  if (order.agent_summary_confirmed_hash === liveHash && order.agent_summary_confirmed_at) {
    return { ok: true, confirmed: true, order_id, summary_hash: liveHash, confirmed_at: order.agent_summary_confirmed_at };
  }

  const confirmedAt = new Date().toISOString();

  const { data: updated, error: updateErr } = await supabase
    .from("orders")
    .update({ agent_summary_confirmed_hash: liveHash, agent_summary_confirmed_at: confirmedAt })
    .eq("order_id", order_id)
    .select("agent_summary_confirmed_hash, agent_summary_confirmed_at");

  if (updateErr) {
    return { ok: false, code: AGENT_ERROR_CODES.CONFIRMATION_FAILED };
  }
  if (!Array.isArray(updated) || updated.length !== 1) {
    return { ok: false, code: AGENT_ERROR_CODES.CONFIRMATION_FAILED };
  }

  return {
    ok: true,
    confirmed: true,
    order_id,
    summary_hash: updated[0].agent_summary_confirmed_hash,
    confirmed_at: updated[0].agent_summary_confirmed_at,
  };
}

module.exports = { confirmBookingSummaryTool, CONFIRMATION_LOOKUP_COLUMNS };
