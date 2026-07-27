// lib/agent/validation/validateBookingInput.js
//
// A1-B03: shared, strict input validation for every Agent tool that reads
// booking-shaped fields from a caller-controlled request body. Runs BEFORE
// any RPC call, any inventory query, and any database write — every
// pages/api/agent/*.js handler that touches booking fields calls one of
// the three entry points below first, and short-circuits to
// AGENT_ERROR_CODES.INVALID_REQUEST on the first failure without ever
// constructing a Supabase client call.
//
// Three entry points, one per tool "shape" (a tool only gets the checks it
// actually needs — check_availability doesn't require pax/luggage/email,
// for example):
//   validateAvailabilityInput  — check_availability
//   validateQuoteInput         — calculate_quote (end_date is REQUIRED here,
//                                 never defaulted to start_date)
//   validateDraftInput         — create_booking_draft (the full field set,
//                                 plus the A1-B01 existing_order_id/order_id
//                                 rejection)
//
// "禁止当日下单" (same-day booking forbidden, Asia/Tokyo calendar date) is
// applied to quote and draft validation — not to availability, which is a
// plain lookup someone may legitimately run for a date they can't actually
// book through this system.

const { VALID_CAR_MODEL_IDS, VALID_DURATIONS } = require("../../pricing/calcTotalPrice");
const { AGENT_ERROR_CODES } = require("../errorCodes");

const VALID_DRIVER_LANG_INPUTS = new Set(["zh", "jp", "ZH", "JP"]);
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Generous, business-compatible upper bounds — first-pass values chosen to
// never reject anything the existing web flow (components/steps/Step2.jsx)
// would legitimately submit, while still bounding a pathological payload.
const TEXT_MAX_LENGTHS = {
  name: 200,
  phone: 50,
  email: 200,
  departure_hotel: 200,
  end_hotel: 200,
  wechat: 100,
  itinerary: 2000,
  remark: 2000,
};

function fail() {
  return { ok: false, code: AGENT_ERROR_CODES.INVALID_REQUEST };
}
function ok() {
  return { ok: true };
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeDriverLangStrict(v) {
  return typeof v === "string" && VALID_DRIVER_LANG_INPUTS.has(v) ? v.toUpperCase() : null;
}

function isValidCarModelId(v) {
  return typeof v === "string" && VALID_CAR_MODEL_IDS.has(v);
}

function isValidDuration(v) {
  return VALID_DURATIONS.has(Number(v));
}

// Real-calendar-date check — rejects Feb 30, month 13, day 32, etc., not
// just the YYYY-MM-DD shape. Date.UTC() silently normalizes out-of-range
// components (e.g. Feb 30 -> Mar 2), so round-tripping the parsed value
// back through the same y/m/d fields and requiring an exact match is what
// actually catches this — a regex alone cannot.
function isRealYMD(s) {
  if (typeof s !== "string" || !YMD_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function ymdToUTCTime(s) {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

// Asia/Tokyo is a fixed UTC+9 offset with no DST, year-round — safe to
// compute without a timezone library.
function todayInTokyoYMD(now) {
  const tokyo = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = tokyo.getUTCFullYear();
  const m = String(tokyo.getUTCMonth() + 1).padStart(2, "0");
  const d = String(tokyo.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// `now` is injectable so tests never depend on the real wall clock;
// production call sites simply omit it and get the real current time.
function isSameDayInTokyo(startDate, now = new Date()) {
  return startDate === todayInTokyoYMD(now);
}

function isPositiveInteger(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0;
}

function isNonNegativeInteger(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0;
}

function isNonBlankText(v, maxLen) {
  return typeof v === "string" && v.trim().length > 0 && v.trim().length <= maxLen;
}

function isValidEmail(v) {
  return isNonBlankText(v, TEXT_MAX_LENGTHS.email) && EMAIL_RE.test(v.trim());
}

// Shared date-range checks used by both quote and draft validation.
function validateDateRange(data, { requireEndDate }) {
  if (!isRealYMD(data.start_date)) return fail();
  if (requireEndDate) {
    if (!isRealYMD(data.end_date)) return fail();
  } else if (data.end_date !== undefined && data.end_date !== null && !isRealYMD(data.end_date)) {
    return fail();
  }
  const endDate = data.end_date || data.start_date;
  if (isRealYMD(endDate) && ymdToUTCTime(endDate) < ymdToUTCTime(data.start_date)) return fail();
  return ok();
}

/**
 * check_availability. Requires: car_model_id, driver_lang, start_date, end_date.
 * No same-day rule (plain lookup, not a booking action).
 */
function validateAvailabilityInput(data) {
  if (!isPlainObject(data)) return fail();
  if (!isValidCarModelId(data.car_model_id)) return fail();
  if (!normalizeDriverLangStrict(data.driver_lang)) return fail();
  const dateCheck = validateDateRange(data, { requireEndDate: true });
  if (!dateCheck.ok) return dateCheck;
  return ok();
}

/**
 * calculate_quote. end_date is explicitly REQUIRED (never defaulted to
 * start_date at this layer, even though lib/pricing/calcTotalPrice.js's own
 * calcDays() would tolerate a missing end_date) — same-day is forbidden.
 */
function validateQuoteInput(data) {
  if (!isPlainObject(data)) return fail();
  if (!isValidCarModelId(data.car_model_id)) return fail();
  if (!normalizeDriverLangStrict(data.driver_lang)) return fail();
  if (!isValidDuration(data.duration)) return fail();
  const dateCheck = validateDateRange(data, { requireEndDate: true });
  if (!dateCheck.ok) return dateCheck;
  if (isSameDayInTokyo(data.start_date)) return fail();
  return ok();
}

/**
 * create_booking_draft. Full booking field set. A1-B01: existing_order_id
 * and order_id are BOTH explicitly rejected here if present at all — A1
 * only ever creates a fresh, server-generated-id draft; there is no
 * "modify an existing draft" path in this tool anymore.
 */
function validateDraftInput(data) {
  if (!isPlainObject(data)) return fail();

  if (data.existing_order_id !== undefined || data.order_id !== undefined) return fail();

  if (!isValidCarModelId(data.car_model_id)) return fail();
  if (!normalizeDriverLangStrict(data.driver_lang)) return fail();
  if (!isValidDuration(data.duration)) return fail();

  const dateCheck = validateDateRange(data, { requireEndDate: true });
  if (!dateCheck.ok) return dateCheck;
  if (isSameDayInTokyo(data.start_date)) return fail();

  if (!isPositiveInteger(data.pax)) return fail();
  if (!isNonNegativeInteger(data.luggage)) return fail();

  if (!isNonBlankText(data.departure_hotel, TEXT_MAX_LENGTHS.departure_hotel)) return fail();
  if (!isNonBlankText(data.end_hotel, TEXT_MAX_LENGTHS.end_hotel)) return fail();
  if (!isNonBlankText(data.name, TEXT_MAX_LENGTHS.name)) return fail();
  if (!isNonBlankText(data.phone, TEXT_MAX_LENGTHS.phone)) return fail();
  if (!isValidEmail(data.email)) return fail();

  // Optional fields: if present, must respect the same length caps; blank/omitted is fine.
  if (data.wechat !== undefined && data.wechat !== null && data.wechat !== "") {
    if (typeof data.wechat !== "string" || data.wechat.trim().length > TEXT_MAX_LENGTHS.wechat) return fail();
  }
  if (data.itinerary !== undefined && data.itinerary !== null && data.itinerary !== "") {
    if (typeof data.itinerary !== "string" || data.itinerary.trim().length > TEXT_MAX_LENGTHS.itinerary) return fail();
  }
  if (data.remark !== undefined && data.remark !== null && data.remark !== "") {
    if (typeof data.remark !== "string" || data.remark.trim().length > TEXT_MAX_LENGTHS.remark) return fail();
  }

  return ok();
}

module.exports = {
  validateAvailabilityInput,
  validateQuoteInput,
  validateDraftInput,
  normalizeDriverLangStrict,
  isRealYMD,
  isSameDayInTokyo,
  todayInTokyoYMD,
  isPositiveInteger,
  isNonNegativeInteger,
  isNonBlankText,
  isValidEmail,
  TEXT_MAX_LENGTHS,
};
