// lib/agent/tools/getBookingSummary.js
//
// Agent tool: get_booking_summary. This is the whitelist replacement for
// pages/api/get-order.js's `select('*')` — it selects ONLY the columns
// listed in SUMMARY_COLUMNS (never `*`), and by default never returns
// name/phone/email/wechat/itinerary/remark at all. Authorization (both the
// service-level Bearer key and the per-order booking_access_token) is
// checked by the caller (pages/api/agent/get-booking-summary.js) BEFORE
// this function ever runs — this function assumes the caller has already
// proven the right to read this specific order_id's summary.
//
// A2: SUMMARY_COLUMNS / HASHED_FIELDS / computeSummaryHash / the row->safe
// summary mapping all moved to lib/agent/bookingSummary.js, the ONE shared
// definition update_booking_draft and confirm_booking_summary also use —
// re-exported here unchanged so this file's own public contract (what
// other modules and existing tests import from it) does not change at all.

const { AGENT_ERROR_CODES } = require("../errorCodes");
const { SUMMARY_COLUMNS, HASHED_FIELDS, computeSummaryHash, toSafeSummary } = require("../bookingSummary");

/**
 * @param {object} params
 * @param {object} params.supabase
 * @param {string} params.order_id
 * @returns {Promise<{ok:true, ...whitelist, summary_hash:string} | {ok:false, code:string}>}
 */
async function getBookingSummaryTool({ supabase, order_id }) {
  if (!order_id) {
    return { ok: false, code: AGENT_ERROR_CODES.INVALID_REQUEST };
  }

  const { data, error } = await supabase
    .from("orders")
    .select(SUMMARY_COLUMNS.join(", "))
    .eq("order_id", order_id)
    .maybeSingle();

  if (error) {
    return { ok: false, code: AGENT_ERROR_CODES.INTERNAL_ERROR };
  }
  if (!data) {
    return { ok: false, code: AGENT_ERROR_CODES.ORDER_NOT_FOUND };
  }

  return { ok: true, ...toSafeSummary(data) };
}

module.exports = { getBookingSummaryTool, SUMMARY_COLUMNS, HASHED_FIELDS, computeSummaryHash };
