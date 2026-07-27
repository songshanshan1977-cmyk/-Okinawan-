// lib/agent/bookingSummary.js
//
// A2: the ONE shared definition of "what a safe booking summary is" —
// extracted from lib/agent/tools/getBookingSummary.js (A1) so that
// get_booking_summary, update_booking_draft, and confirm_booking_summary
// all compute summary_hash the exact same way and expose the exact same
// PII-free field whitelist. There must never be a second copy of
// SUMMARY_COLUMNS / HASHED_FIELDS / computeSummaryHash anywhere in this
// codebase — every Agent tool that needs any of these imports them from
// here.
//
// SUMMARY_COLUMNS is the fixed SELECT whitelist every read of an order for
// display purposes uses — never select('*'). By default this excludes
// name/phone/email/wechat/itinerary/remark entirely; nothing in this file
// returns them.
//
// HASHED_FIELDS is exactly the fields whose change should invalidate a
// customer's prior confirmation of "this is what I'm booking".
// payment_status/inventory_status are deliberately EXCLUDED: those change
// as an expected, normal side effect of the SAME booking progressing
// (draft -> paid, etc.) and must not retroactively invalidate a
// confirmation of the booking's actual content.
//
// Hash encoding: lib/agent/hashUtils.js's computeFieldsHash — a
// JSON.stringify(ordered [key,value] pairs) scheme, collision-free unlike a
// naive `key=value` join (see __tests__/agent/lib/hashUtils.test.js).

const { computeFieldsHash } = require("./hashUtils");

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

// Maps a raw `orders` row (already read via a SUMMARY_COLUMNS-shaped
// select, or a superset of it) to the exact safe-summary shape every Agent
// tool that displays a summary returns. Callers add their own `ok` (and
// any tool-specific extra fields like `updated`/`confirmed`) on top.
function toSafeSummary(row) {
  const balance_due = Math.max(Number(row.total_price || 0) - Number(row.deposit_amount || 0), 0);

  return {
    order_id: row.order_id,
    start_date: row.start_date,
    end_date: row.end_date,
    car_model_id: row.car_model_id,
    driver_lang: row.driver_lang,
    duration: row.duration,
    pax: row.pax,
    luggage: row.luggage,
    departure_hotel: row.departure_hotel,
    end_hotel: row.end_hotel,
    total_price: row.total_price,
    deposit_amount: row.deposit_amount,
    balance_due,
    currency: "CNY",
    payment_status: row.payment_status,
    inventory_status: row.inventory_status,
    summary_hash: computeSummaryHash(row),
  };
}

// Shared "is this order still safe for an Agent to write to" gate — both
// update_booking_draft and confirm_booking_summary use exactly this rule
// (only draft/pending orders may be updated or have their summary
// confirmed; anything else, most importantly 'paid', is immutable from the
// Agent's side).
function isOrderEditable(paymentStatus) {
  const status = String(paymentStatus || "").toLowerCase();
  return status === "draft" || status === "pending";
}

module.exports = { SUMMARY_COLUMNS, HASHED_FIELDS, computeSummaryHash, toSafeSummary, isOrderEditable };
