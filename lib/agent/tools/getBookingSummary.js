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
// summary_hash is a deterministic SHA-256 over exactly the fields whose
// change should invalidate a customer's prior confirmation of "this is
// what I'm booking" (HASHED_FIELDS below). payment_status/inventory_status
// are deliberately EXCLUDED from the hash: those change as an expected,
// normal side effect of the SAME booking progressing (draft -> paid, etc.)
// and must not retroactively invalidate a confirmation of the booking's
// actual content. This hash is computed fresh on every call in A1 — it is
// NOT persisted or compared against anything yet (persisted confirmation
// state is explicitly out of scope for A1; see the round's report).
//
// A1-B04: encoding uses lib/agent/hashUtils.js's computeFieldsHash — a
// JSON.stringify(ordered [key,value] pairs) scheme, NOT the original
// `key=value` parts joined with `|`, which was not collision-free (a field
// value itself containing `|` or `=` could make two different rows hash
// identically). See __tests__/agent/lib/hashUtils.test.js for the specific
// collision this replaces.

const { AGENT_ERROR_CODES } = require("../errorCodes");
const { computeFieldsHash } = require("../hashUtils");

const SUMMARY_COLUMNS = [
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
];

// Order matters here only for reproducibility of the hash input string —
// it does not imply anything about database column order.
const HASHED_FIELDS = [
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
];

function computeSummaryHash(row) {
  return computeFieldsHash(HASHED_FIELDS, row);
}

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

  const balance_due = Math.max(Number(data.total_price || 0) - Number(data.deposit_amount || 0), 0);

  return {
    ok: true,
    order_id: data.order_id,
    start_date: data.start_date,
    end_date: data.end_date,
    car_model_id: data.car_model_id,
    driver_lang: data.driver_lang,
    duration: data.duration,
    pax: data.pax,
    luggage: data.luggage,
    departure_hotel: data.departure_hotel,
    end_hotel: data.end_hotel,
    total_price: data.total_price,
    deposit_amount: data.deposit_amount,
    balance_due,
    currency: "CNY",
    payment_status: data.payment_status,
    inventory_status: data.inventory_status,
    summary_hash: computeSummaryHash(data),
  };
}

module.exports = { getBookingSummaryTool, SUMMARY_COLUMNS, HASHED_FIELDS, computeSummaryHash };
