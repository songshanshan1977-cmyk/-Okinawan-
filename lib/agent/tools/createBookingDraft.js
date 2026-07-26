// lib/agent/tools/createBookingDraft.js
//
// Agent tool: create_booking_draft. Composes four PIECES PR #1 already
// froze — checkAvailability, buildNormalizedContent (which itself calls
// calcTotalPrice), contentsEqual, and insertNewDraftWithRetry — the same
// building blocks pages/api/create-order.js is built from. This file does
// NOT call create-order.js over HTTP (forbidden by the A1 instructions);
// it calls the underlying lib functions directly, in-process.
//
// Two deliberate differences from create-order.js's own behavior, both are
// restructuring PR #1's shared building blocks, not modifying create-order.js
// itself (which is untouched — see the branch diff):
//
//   1. This tool NEVER accepts a caller-supplied order_id for a brand-new
//      draft. create-order.js's original "no existing row" branch inserts
//      using the CLIENT's own order_id verbatim — safe for the web
//      frontend (which generates its own id client-side before any row
//      exists to collide with), but not something an Agent caller should
//      be trusted to dictate. This tool instead ALWAYS uses
//      insertNewDraftWithRetry (server-generated id) for a first-time
//      draft, and only ever looks up an existing row via the OPTIONAL,
//      distinctly-named `existing_order_id` input — never uses that value
//      as the id of any newly-inserted row either (matches
//      insertNewDraftWithRetry's own "content different -> supersede with
//      a FRESH server-generated id" behavior exactly).
//
//   2. This tool runs the shared checkAvailability gate before inserting a
//      genuinely new row (brand-new, or "existing draft superseded because
//      content changed") — create-order.js itself does not re-check
//      availability (that already happens earlier, in Step2's own
//      check-inventory.js call) because the web flow trusts its own prior
//      UI step; an Agent caller has no such prior step to trust, so this
//      tool re-checks explicitly.
//
// deposit_amount is never read from the caller — buildNormalizedContent
// already hardcodes FIXED_DEPOSIT_AMOUNT (500) into every content object it
// produces, so there is structurally no code path in this file that could
// pass a caller-supplied deposit_amount through to the database.

const { checkAvailability } = require("../../inventory/checkAvailability");
const { buildNormalizedContent, contentsEqual } = require("../../orders/normalizeOrderContent");
const { insertNewDraftWithRetry } = require("../../orders/generateOrderId");
const { issueBookingAccessToken } = require("../tokens/bookingAccessToken");
const { AGENT_ERROR_CODES } = require("../errorCodes");

const REQUIRED_FIELDS = [
  "car_model_id",
  "driver_lang",
  "duration",
  "start_date",
  "end_date",
  "departure_hotel",
  "end_hotel",
  "pax",
  "luggage",
  "name",
  "phone",
  "email",
];

const CONTENT_SHAPE_ERRORS = new Set(["invalid_pricing_request", "invalid_car_model", "invalid_duration", "invalid_driver_lang"]);

function findMissingField(data) {
  for (const field of REQUIRED_FIELDS) {
    if (data[field] === null || data[field] === undefined || data[field] === "") return field;
  }
  return null;
}

// Mirrors pages/api/create-order.js's local isPaidOrImmutable() byte-for-byte
// (that function is not exported from anywhere reusable, and create-order.js
// itself must not be modified to export it) — any draft/pending status stays
// mutable, anything else (paid, or any future non-draft status) is frozen.
function isPaidOrImmutable(order) {
  const status = String(order?.payment_status || "").toLowerCase();
  return status !== "draft" && status !== "pending";
}

function mapContentError(error) {
  return CONTENT_SHAPE_ERRORS.has(error) ? AGENT_ERROR_CODES.INVALID_REQUEST : AGENT_ERROR_CODES.QUOTE_FAILED;
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
    return { ok: false, code: availability.error === "inventory_check_failed" ? AGENT_ERROR_CODES.INVENTORY_CHECK_FAILED : AGENT_ERROR_CODES.INVALID_REQUEST };
  }
  if (!availability.available) {
    return { ok: false, code: AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE };
  }
  return { ok: true };
}

function toOutput(order, { created_new_order, previous_order_id, tokenResult }) {
  return {
    ok: true,
    order_id: order.order_id,
    payment_status: order.payment_status,
    inventory_status: order.inventory_status,
    total_price: order.total_price,
    deposit_amount: order.deposit_amount,
    balance_due: Math.max(Number(order.total_price || 0) - Number(order.deposit_amount || 0), 0),
    currency: "CNY",
    created_new_order: !!created_new_order,
    previous_order_id: previous_order_id || null,
    booking_access_token: tokenResult.token,
    expires_at: tokenResult.expires_at,
  };
}

/**
 * @param {object} params
 * @param {object} params.supabase
 * @param {object} params.data - raw booking + contact fields (see REQUIRED_FIELDS); MAY include
 *   optional wechat/itinerary/remark/existing_order_id. total_price/deposit_amount/payment_status/
 *   inventory_status/stripe_session_id are never read from this object even if present.
 * @returns {Promise<{ok:true, ...} | {ok:false, code:string}>}
 */
async function createBookingDraftTool({ supabase, data }) {
  const missingField = findMissingField(data || {});
  if (missingField) {
    return { ok: false, code: AGENT_ERROR_CODES.INVALID_REQUEST };
  }

  // Fail closed on a missing token secret BEFORE any database write, so a
  // draft row is never created that this call could then not hand back a
  // usable booking_access_token for.
  const secretPreflight = issueBookingAccessToken({ order_id: "preflight-check-only" });
  if (!secretPreflight.ok && secretPreflight.code === AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED) {
    return { ok: false, code: AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED };
  }

  const existingOrderId = data.existing_order_id;

  if (existingOrderId) {
    const { data: existing, error: lookupErr } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", String(existingOrderId).trim())
      .maybeSingle();

    if (lookupErr) {
      return { ok: false, code: AGENT_ERROR_CODES.DRAFT_CREATION_FAILED };
    }
    if (!existing) {
      return { ok: false, code: AGENT_ERROR_CODES.ORDER_NOT_FOUND };
    }
    if (isPaidOrImmutable(existing)) {
      return { ok: false, code: AGENT_ERROR_CODES.PAID_ORDER_IMMUTABLE };
    }

    // source is forced to "agent" on BOTH sides of the comparison below —
    // never left to vary between the new submission and the existing row —
    // so it can never by itself make otherwise-identical content look
    // "different" (which would force a pointless supersede) while still
    // guaranteeing any row this tool actually INSERTS is tagged source:
    // "agent" (see the two insertNewDraftWithRetry call sites below).
    const newContentResult = await buildNormalizedContent({ supabase, raw: { ...data, source: "agent" } });
    if (!newContentResult.ok) {
      return { ok: false, code: mapContentError(newContentResult.error) };
    }

    const existingContentResult = await buildNormalizedContent({
      supabase,
      raw: { ...existing, source: "agent" },
      knownTotalPrice: existing.total_price,
    });

    const sameContent = existingContentResult.ok && contentsEqual(newContentResult.content, existingContentResult.content);

    let order;
    let created_new_order;
    let previous_order_id = null;

    if (sameContent) {
      order = existing;
      created_new_order = false;
    } else {
      const gate = await runAvailabilityGate({ supabase, content: newContentResult.content });
      if (!gate.ok) return gate;

      const insertResult = await insertNewDraftWithRetry({ supabase, content: newContentResult.content });
      if (!insertResult.ok) {
        return { ok: false, code: AGENT_ERROR_CODES.DRAFT_CREATION_FAILED };
      }
      order = insertResult.order;
      created_new_order = true;
      previous_order_id = existing.order_id;
    }

    const tokenResult = issueBookingAccessToken({ order_id: order.order_id });
    if (!tokenResult.ok) {
      return { ok: false, code: tokenResult.code };
    }

    return toOutput(order, { created_new_order, previous_order_id, tokenResult });
  }

  // Brand-new draft: no existing_order_id given at all. source is forced to
  // "agent" regardless of any data.source the caller might have sent.
  const contentResult = await buildNormalizedContent({ supabase, raw: { ...data, source: "agent" } });
  if (!contentResult.ok) {
    return { ok: false, code: mapContentError(contentResult.error) };
  }

  const gate = await runAvailabilityGate({ supabase, content: contentResult.content });
  if (!gate.ok) return gate;

  const insertResult = await insertNewDraftWithRetry({ supabase, content: contentResult.content });
  if (!insertResult.ok) {
    return { ok: false, code: AGENT_ERROR_CODES.DRAFT_CREATION_FAILED };
  }

  const tokenResult = issueBookingAccessToken({ order_id: insertResult.order.order_id });
  if (!tokenResult.ok) {
    return { ok: false, code: tokenResult.code };
  }

  return toOutput(insertResult.order, { created_new_order: true, previous_order_id: null, tokenResult });
}

module.exports = { createBookingDraftTool, isPaidOrImmutable, REQUIRED_FIELDS };
