// lib/agent/tools/calculateQuote.js
//
// Agent tool: calculate_quote. Thin wrapper around the shared
// lib/pricing/calcTotalPrice.js — the SAME function pages/api/create-order.js
// uses to recompute price server-side. The Agent (and whatever produced its
// prompt/instructions) never supplies a price; this tool is the only source
// of a price an Agent may show a customer, and create_booking_draft
// independently re-derives price itself rather than trusting a value
// carried over from a prior calculate_quote call.
//
// deposit_amount is the same fixed business constant PR #1 already froze in
// lib/orders/normalizeOrderContent.js (FIXED_DEPOSIT_AMOUNT = 500) — not
// re-declared as a separate literal here to avoid two independent "500"s
// that could drift; imported directly from that module.

const { calcTotalPrice } = require("../../pricing/calcTotalPrice");
const { FIXED_DEPOSIT_AMOUNT } = require("../../orders/normalizeOrderContent");
const { AGENT_ERROR_CODES } = require("../errorCodes");

const SHAPE_ERRORS = new Set(["invalid_pricing_request", "invalid_car_model", "invalid_duration", "invalid_driver_lang"]);

/**
 * @param {object} params
 * @param {object} params.supabase
 * @param {string} params.start_date
 * @param {string} params.end_date
 * @param {string} params.car_model_id
 * @param {string} params.driver_lang
 * @param {number} params.duration
 * @returns {Promise<{ok:true, total_price:number, deposit_amount:number, balance_due:number, currency:"CNY", days_count:number} | {ok:false, code:string}>}
 */
async function calculateQuoteTool({ supabase, start_date, end_date, car_model_id, driver_lang, duration }) {
  const result = await calcTotalPrice({ supabase, car_model_id, driver_lang, duration, start_date, end_date });

  if (!result.ok) {
    const code = SHAPE_ERRORS.has(result.error) ? AGENT_ERROR_CODES.INVALID_REQUEST : AGENT_ERROR_CODES.QUOTE_FAILED;
    return { ok: false, code };
  }

  const balance_due = Math.max(result.total_price - FIXED_DEPOSIT_AMOUNT, 0);

  return {
    ok: true,
    total_price: result.total_price,
    deposit_amount: FIXED_DEPOSIT_AMOUNT,
    balance_due,
    currency: "CNY",
    days_count: result.days,
  };
}

module.exports = { calculateQuoteTool };
