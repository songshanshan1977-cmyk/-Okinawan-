// lib/agent/tools/getPaymentStatus.js
//
// Agent tool: get_payment_status (A3). A pure, read-only, whitelist-only
// status check — never queries Stripe, never mutates the order, never
// returns PII or the raw stripe_session_id. `paid` is derived from nothing
// but the database's own payment_status column: pages/api/stripe-webhook.js
// remains the ONLY place that ever sets payment_status to "paid" (see that
// file's header) — this tool just reads whatever it already wrote.
//
// Authorization (both the service-level Bearer key and the per-order
// booking_access_token) is checked by the caller
// (pages/api/agent/get-payment-status.js) BEFORE this function ever runs.

const { AGENT_ERROR_CODES } = require("../errorCodes");

// Deliberately NOT lib/agent/bookingSummary.js's SUMMARY_COLUMNS — this
// tool has no business content or price to show, only payment/inventory
// state, so its own minimal whitelist is used instead. Never select('*').
const GET_PAYMENT_STATUS_COLUMNS = ["order_id", "payment_status", "inventory_status", "inventory_locked"];

/**
 * @param {object} params
 * @param {object} params.supabase
 * @param {string} params.order_id
 * @returns {Promise<
 *   {ok:true, order_id:string, payment_status:string, inventory_status:string, inventory_locked:boolean, paid:boolean}
 *   | {ok:false, code:string}
 * >}
 */
async function getPaymentStatusTool({ supabase, order_id }) {
  if (!order_id || typeof order_id !== "string") {
    return { ok: false, code: AGENT_ERROR_CODES.INVALID_REQUEST };
  }

  const { data, error } = await supabase
    .from("orders")
    .select(GET_PAYMENT_STATUS_COLUMNS.join(", "))
    .eq("order_id", order_id)
    .maybeSingle();

  if (error) {
    return { ok: false, code: AGENT_ERROR_CODES.INTERNAL_ERROR };
  }
  if (!data) {
    return { ok: false, code: AGENT_ERROR_CODES.ORDER_NOT_FOUND };
  }

  return {
    ok: true,
    order_id: data.order_id,
    payment_status: data.payment_status,
    inventory_status: data.inventory_status,
    inventory_locked: Boolean(data.inventory_locked),
    paid: data.payment_status === "paid",
  };
}

module.exports = { getPaymentStatusTool, GET_PAYMENT_STATUS_COLUMNS };
