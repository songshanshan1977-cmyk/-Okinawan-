// lib/agent/tools/updateBookingDraft.js
//
// Agent tool: update_booking_draft (A2). Lets an Agent apply a PARTIAL
// change to an existing, still-editable (draft/pending) draft the customer
// already created in A1 — e.g. correcting a date or a hotel name after
// seeing the summary — and always ends with a fresh summary_hash the
// customer must re-confirm (see the "confirmation invalidation" rule
// below).
//
// Never trusts, and never even reads off `changes`: total_price,
// deposit_amount, payment_status, inventory_status, stripe_session_id,
// agent_summary_confirmed_hash, agent_summary_confirmed_at, order_id,
// source. Only the fixed ALLOWED_CHANGE_FIELDS below may appear in
// `changes` at all — anything else present is invalid_request, not
// silently ignored.
//
// Reuses, never re-implements: lib/agent/validation/validateBookingInput.js
// (validateDraftInput, run against the MERGED full content — not just the
// changed fields), lib/pricing/calcTotalPrice.js (the same server-side
// price authority create_booking_draft uses), lib/inventory/checkAvailability.js,
// lib/orders/normalizeOrderContent.js's FIXED_DEPOSIT_AMOUNT, and
// lib/agent/bookingSummary.js (the one shared summary whitelist/hash/output
// shape get_booking_summary and confirm_booking_summary also use).
//
// Confirmation invalidation: ANY successful update — even one that only
// touches contact fields, never a "priced" field — clears
// agent_summary_confirmed_hash/agent_summary_confirmed_at in the SAME
// database write. A2 deliberately does not try to distinguish "this field
// change doesn't really require re-confirmation" — every successful update
// requires the customer to see and re-confirm the new summary.
//
// Deliberately NOT a database-level concurrency primitive the way
// create_booking_draft's idempotent insert is: expected_summary_hash is an
// application-level optimistic check against a normal single Agent
// session's own stale view, not a defense against genuinely simultaneous
// concurrent writers. That is an explicit, documented non-goal for A2 (see
// the round's report).

const { checkAvailability } = require("../../inventory/checkAvailability");
const { calcTotalPrice } = require("../../pricing/calcTotalPrice");
const { FIXED_DEPOSIT_AMOUNT } = require("../../orders/normalizeOrderContent");
const { validateDraftInput } = require("../validation/validateBookingInput");
const { SUMMARY_COLUMNS, HASHED_FIELDS, computeSummaryHash, toSafeSummary, isOrderEditable } = require("../bookingSummary");
const { AGENT_ERROR_CODES } = require("../errorCodes");

// The ONLY fields update_booking_draft will ever read off `changes`. Any
// other key present in `changes` — including every field this file's own
// header comment lists as never-trusted — is rejected outright.
const ALLOWED_CHANGE_FIELDS = [
  "start_date",
  "end_date",
  "car_model_id",
  "driver_lang",
  "duration",
  "pax",
  "luggage",
  "departure_hotel",
  "end_hotel",
  "name",
  "phone",
  "email",
  "wechat",
  "itinerary",
  "remark",
];

// Read internally to merge `changes` on top of — a superset of
// SUMMARY_COLUMNS (adds the PII/contact fields needed to reconstruct full
// business content for validation) that this tool needs to operate, but
// which is NEVER returned to the caller directly — every response is built
// through lib/agent/bookingSummary.js's toSafeSummary().
const ORDER_MERGE_COLUMNS = [
  "order_id",
  "payment_status",
  "start_date",
  "end_date",
  "car_model_id",
  "driver_lang",
  "duration",
  "pax",
  "luggage",
  "departure_hotel",
  "end_hotel",
  "name",
  "phone",
  "email",
  "wechat",
  "itinerary",
  "remark",
];

const CONTENT_SHAPE_ERRORS = new Set(["invalid_pricing_request", "invalid_car_model", "invalid_duration", "invalid_driver_lang"]);

function mapPriceError(error) {
  return CONTENT_SHAPE_ERRORS.has(error) ? AGENT_ERROR_CODES.INVALID_REQUEST : AGENT_ERROR_CODES.QUOTE_FAILED;
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Builds the merged candidate to validate/price/write: current order's
// business fields, with only the keys actually present in `changes`
// overridden. Returns {ok:false} if `changes` contains ANY key outside
// ALLOWED_CHANGE_FIELDS (this also structurally rejects total_price,
// deposit_amount, payment_status, inventory_status, stripe_session_id,
// agent_summary_confirmed_hash, agent_summary_confirmed_at, order_id,
// source — none of those are ever in ALLOWED_CHANGE_FIELDS).
function mergeChanges(currentOrder, changes) {
  const changeKeys = Object.keys(changes);
  for (const key of changeKeys) {
    if (!ALLOWED_CHANGE_FIELDS.includes(key)) {
      return { ok: false };
    }
  }

  const merged = {};
  for (const field of ALLOWED_CHANGE_FIELDS) {
    merged[field] = Object.prototype.hasOwnProperty.call(changes, field) ? changes[field] : currentOrder[field];
  }
  return { ok: true, merged };
}

async function runAvailabilityGate({ supabase, content }) {
  const availability = await checkAvailability({
    supabase,
    start_date: content.start_date,
    end_date: content.end_date,
    car_model_id: content.car_model_id,
    driver_lang: content.driver_lang,
  });

  if (!availability.ok) {
    return {
      ok: false,
      code: availability.error === "inventory_check_failed" ? AGENT_ERROR_CODES.INVENTORY_CHECK_FAILED : AGENT_ERROR_CODES.INVALID_REQUEST,
    };
  }
  if (!availability.available) {
    return { ok: false, code: AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE };
  }
  return { ok: true };
}

/**
 * @param {object} params
 * @param {object} params.supabase
 * @param {string} params.order_id
 * @param {string} params.expected_summary_hash
 * @param {object} params.changes - partial update, ALLOWED_CHANGE_FIELDS only
 * @returns {Promise<{ok:true, ...safeSummary, updated:true, confirmed:false} | {ok:false, code:string}>}
 */
async function updateBookingDraftTool({ supabase, order_id, expected_summary_hash, changes }) {
  if (!order_id || typeof order_id !== "string") {
    return { ok: false, code: AGENT_ERROR_CODES.INVALID_REQUEST };
  }
  if (!expected_summary_hash || typeof expected_summary_hash !== "string") {
    return { ok: false, code: AGENT_ERROR_CODES.INVALID_REQUEST };
  }
  if (!isPlainObject(changes)) {
    return { ok: false, code: AGENT_ERROR_CODES.INVALID_REQUEST };
  }

  const { data: currentOrder, error: readErr } = await supabase.from("orders").select(ORDER_MERGE_COLUMNS.join(", ")).eq("order_id", order_id).maybeSingle();

  if (readErr) {
    return { ok: false, code: AGENT_ERROR_CODES.UPDATE_FAILED };
  }
  if (!currentOrder) {
    return { ok: false, code: AGENT_ERROR_CODES.ORDER_NOT_FOUND };
  }
  if (!isOrderEditable(currentOrder.payment_status)) {
    return { ok: false, code: AGENT_ERROR_CODES.PAID_ORDER_IMMUTABLE };
  }

  const liveHash = computeSummaryHash(currentOrder);
  if (expected_summary_hash !== liveHash) {
    return { ok: false, code: AGENT_ERROR_CODES.SUMMARY_STALE };
  }

  const mergeResult = mergeChanges(currentOrder, changes);
  if (!mergeResult.ok) {
    return { ok: false, code: AGENT_ERROR_CODES.INVALID_REQUEST };
  }
  const candidate = mergeResult.merged;

  const validation = validateDraftInput(candidate);
  if (!validation.ok) {
    return validation;
  }

  const priceResult = await calcTotalPrice({
    supabase,
    car_model_id: candidate.car_model_id,
    driver_lang: candidate.driver_lang,
    duration: candidate.duration,
    start_date: candidate.start_date,
    end_date: candidate.end_date,
  });
  if (!priceResult.ok) {
    return { ok: false, code: mapPriceError(priceResult.error) };
  }

  const gate = await runAvailabilityGate({ supabase, content: candidate });
  if (!gate.ok) return gate;

  const { data: updated, error: updateErr } = await supabase
    .from("orders")
    .update({
      start_date: candidate.start_date,
      end_date: candidate.end_date,
      car_model_id: candidate.car_model_id,
      driver_lang: candidate.driver_lang,
      duration: candidate.duration,
      pax: candidate.pax,
      luggage: candidate.luggage,
      departure_hotel: candidate.departure_hotel,
      end_hotel: candidate.end_hotel,
      name: candidate.name,
      phone: candidate.phone,
      email: candidate.email,
      wechat: candidate.wechat,
      itinerary: candidate.itinerary,
      remark: candidate.remark,
      total_price: priceResult.total_price,
      deposit_amount: FIXED_DEPOSIT_AMOUNT,
      agent_summary_confirmed_hash: null,
      agent_summary_confirmed_at: null,
    })
    .eq("order_id", order_id)
    .select(SUMMARY_COLUMNS.join(", "));

  if (updateErr) {
    return { ok: false, code: AGENT_ERROR_CODES.UPDATE_FAILED };
  }
  if (!Array.isArray(updated) || updated.length !== 1) {
    // Response shape this code has no defined interpretation for — never
    // guess which row (if any) actually reflects the write.
    return { ok: false, code: AGENT_ERROR_CODES.UPDATE_FAILED };
  }

  return {
    ok: true,
    updated: true,
    confirmed: false,
    ...toSafeSummary(updated[0]),
  };
}

module.exports = { updateBookingDraftTool, ALLOWED_CHANGE_FIELDS, ORDER_MERGE_COLUMNS };
