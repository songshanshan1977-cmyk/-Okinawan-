// lib/agent/tools/createPaymentLink.js
//
// Agent tool: create_payment_link (A3). The Agent-side entry point into the
// exact same one-time payment authorization flow the website's Step4 uses —
// lib/payment/paymentAuthorization.js (issue) and
// lib/payment/createCheckoutSession.js (consume + create Stripe Session) are
// called directly, never through an internal HTTP hop, so the web and Agent
// surfaces can never enforce different rules.
//
// Authorization (both the service-level Bearer key and the per-order
// booking_access_token) is checked by the caller
// (pages/api/agent/create-payment-link.js) BEFORE this function ever runs —
// this function assumes the caller has already proven the right to act on
// this specific order_id.
//
// The Agent-side confirmation gate this tool additionally enforces, on top
// of that two-layer auth: the customer must have already explicitly
// confirmed the CURRENT summary via confirm_booking_summary (A2) —
// agent_summary_confirmed_hash must be set, agent_summary_confirmed_at must
// be set, AND agent_summary_confirmed_hash must equal the order's live
// summary_hash right now (if the order changed since confirmation, the old
// confirmation no longer counts — same "confirmation invalidation" rule
// lib/agent/tools/updateBookingDraft.js already enforces by clearing both
// confirmation columns on every successful update).
//
// This tool issues a fresh authorization and immediately consumes it
// server-side in the same call — the Agent never sees the raw
// payment_token, only the resulting Checkout URL. Never returns PII, a
// token hash, the summary_hash itself, or the raw stripe_session_id.

const { SUMMARY_COLUMNS, computeSummaryHash, isPaymentAttemptable } = require("../bookingSummary");
const { issuePaymentAuthorization } = require("../../payment/paymentAuthorization");
const { createCheckoutSession } = require("../../payment/createCheckoutSession");
const { AGENT_ERROR_CODES } = require("../errorCodes");

// SUMMARY_COLUMNS (which already covers every HASHED_FIELDS column plus
// payment_status/inventory_status) plus the two A2 confirmation columns
// this tool specifically needs to decide confirmed-and-current vs not.
// Still a fixed whitelist — never select('*') — and neither confirmation
// column, nor the summary_hash itself, is ever returned to the caller.
const PAYMENT_LINK_LOOKUP_COLUMNS = [...SUMMARY_COLUMNS, "agent_summary_confirmed_hash", "agent_summary_confirmed_at"];

/**
 * @param {object} params
 * @param {object} params.supabase
 * @param {object} params.stripe - a constructed Stripe client (injected, see
 *   lib/payment/createCheckoutSession.js)
 * @param {string} params.order_id
 * @returns {Promise<
 *   {ok:true, order_id:string, payment_status:"pending", url:string, expires_at:string}
 *   | {ok:false, code:string, unavailable_dates?:Array}
 * >}
 */
async function createPaymentLinkTool({ supabase, stripe, order_id }) {
  if (!order_id || typeof order_id !== "string") {
    return { ok: false, code: AGENT_ERROR_CODES.INVALID_REQUEST };
  }

  const { data: order, error: readErr } = await supabase
    .from("orders")
    .select(PAYMENT_LINK_LOOKUP_COLUMNS.join(", "))
    .eq("order_id", order_id)
    .maybeSingle();

  if (readErr) {
    return { ok: false, code: AGENT_ERROR_CODES.INTERNAL_ERROR };
  }
  if (!order) {
    return { ok: false, code: AGENT_ERROR_CODES.ORDER_NOT_FOUND };
  }
  if (!isPaymentAttemptable(order.payment_status)) {
    return { ok: false, code: AGENT_ERROR_CODES.PAID_ORDER_IMMUTABLE };
  }

  const liveHash = computeSummaryHash(order);
  const isConfirmedAndCurrent = Boolean(order.agent_summary_confirmed_hash) && Boolean(order.agent_summary_confirmed_at) && order.agent_summary_confirmed_hash === liveHash;

  if (!isConfirmedAndCurrent) {
    return { ok: false, code: AGENT_ERROR_CODES.SUMMARY_NOT_CONFIRMED };
  }

  const authResult = await issuePaymentAuthorization({ supabase, order });
  if (!authResult.ok) {
    return { ok: false, code: authResult.code };
  }

  const sessionResult = await createCheckoutSession({ supabase, stripe, order_id, payment_token: authResult.token });
  if (!sessionResult.ok) {
    return sessionResult.code === AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE
      ? { ok: false, code: sessionResult.code, unavailable_dates: sessionResult.unavailable_dates }
      : { ok: false, code: sessionResult.code };
  }

  return {
    ok: true,
    order_id: sessionResult.order_id,
    payment_status: sessionResult.payment_status,
    url: sessionResult.url,
    expires_at: authResult.expires_at,
  };
}

module.exports = { createPaymentLinkTool, PAYMENT_LINK_LOOKUP_COLUMNS };
