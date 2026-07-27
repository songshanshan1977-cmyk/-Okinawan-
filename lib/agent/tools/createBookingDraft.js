// lib/agent/tools/createBookingDraft.js
//
// Agent tool: create_booking_draft. A1-B01/B02/B03 rewrite.
//
// A1-B01: this tool ONLY EVER creates a fresh, server-generated-id draft.
// `existing_order_id` and `order_id` are both REJECTED outright by
// lib/agent/validation/validateBookingInput.js's validateDraftInput() if
// present at all — there is no "look up / compare / supersede / reuse an
// existing draft" code path in this file anymore. Modifying an existing
// draft is explicitly out of scope for A1 and must go through a separate,
// future tool that requires the original booking_access_token.
//
// A1-B02: requires a caller-supplied Idempotency-Key (raw value passed in
// as `idempotencyKey`, extracted from the request header by
// pages/api/agent/create-booking-draft.js — never logged in the clear
// anywhere). The raw key is hashed (SHA-256) before ever touching the
// database; a second, separate hash covers the normalized request content
// (IDEMPOTENCY_REQUEST_FIELDS below). Concurrency safety comes from a real,
// NAMED, table-wide UNIQUE constraint on orders.agent_idempotency_key_hash
// (orders_agent_idempotency_key_hash_key — see the migration) plus a single
// atomic `INSERT ... ON CONFLICT (agent_idempotency_key_hash) DO NOTHING`
// statement (via supabase-js .upsert(row, {onConflict, ignoreDuplicates:
// true})) — NOT a "select existing, then insert if absent" pattern, which
// cannot close the race between the read and the write. No in-process
// cache of any kind is used; every idempotency decision is made by the
// database.
//
// A1-R1-B05: the constraint is deliberately NOT a partial index (no WHERE
// clause) — a partial unique index cannot be inferred by a plain
// `ON CONFLICT (columns) DO NOTHING` (PostgREST's onConflict parameter has
// no way to also repeat a partial predicate), so the earlier revision of
// this file's migration would have failed the first time it actually ran
// against real Postgres. See the migration file's header for the full
// explanation. This revision also hardens insertIdempotentDraft()'s
// handling of the upsert response: error / exactly-one-row / null-or-empty
// / anything else (multiple rows, or an unrecognized shape) are each
// handled as their own explicit case — an unrecognized shape is always a
// stable failure, never a guess, and never something a token gets issued
// off of.
//
// A1-B03: lib/agent/validation/validateBookingInput.js's validateDraftInput()
// runs FIRST, before any Supabase call of any kind (including the
// checkAvailability gate) — see createBookingDraftTool() below.

const { checkAvailability } = require("../../inventory/checkAvailability");
const { buildNormalizedContent } = require("../../orders/normalizeOrderContent");
const { generateOrderId, UNIQUE_VIOLATION_CODE } = require("../../orders/generateOrderId");
const { issueBookingAccessToken } = require("../tokens/bookingAccessToken");
const { validateDraftInput } = require("../validation/validateBookingInput");
const { computeFieldsHash } = require("../hashUtils");
const { AGENT_ERROR_CODES } = require("../errorCodes");
const crypto = require("crypto");

const CONTENT_SHAPE_ERRORS = new Set(["invalid_pricing_request", "invalid_car_model", "invalid_duration", "invalid_driver_lang"]);

const MAX_ORDER_ID_ATTEMPTS = 3;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

// The caller-supplied fields that determine "is this the same request" —
// deliberately the INPUT fields only, never total_price/deposit_amount/
// payment_status/inventory_status/stripe_session_id (createBookingDraftTool
// never reads those off `data` in the first place, so they could not
// influence this hash even if a caller sent them).
const IDEMPOTENCY_REQUEST_FIELDS = [
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
  "wechat",
  "itinerary",
  "remark",
];

function mapContentError(error) {
  return CONTENT_SHAPE_ERRORS.has(error) ? AGENT_ERROR_CODES.INVALID_REQUEST : AGENT_ERROR_CODES.QUOTE_FAILED;
}

function hashIdempotencyKey(rawKey) {
  return crypto.createHash("sha256").update(String(rawKey), "utf8").digest("hex");
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

function toOutput(order, tokenResult) {
  return {
    ok: true,
    order_id: order.order_id,
    payment_status: order.payment_status,
    inventory_status: order.inventory_status,
    total_price: order.total_price,
    deposit_amount: order.deposit_amount,
    balance_due: Math.max(Number(order.total_price || 0) - Number(order.deposit_amount || 0), 0),
    currency: "CNY",
    booking_access_token: tokenResult.token,
    expires_at: tokenResult.expires_at,
  };
}

// Attempts the atomic idempotent insert, retrying only on an order_id
// collision (a DIFFERENT unique constraint than the one this statement's
// ON CONFLICT target names, so it surfaces as a real 23505 error rather
// than being silently absorbed — see the file header). Returns:
//   {inserted: true,  order: <row>}   — this call created the row (exactly
//                                        one row came back)
//   {inserted: false}                 — the idempotency key already had a
//                                        row (ON CONFLICT DO NOTHING fired,
//                                        `data` came back null or []);
//                                        caller must read it separately
//   {ok: false, code: ...}            — a real failure: a database error,
//                                        OR a response shape this code has
//                                        no defined interpretation for
//                                        (more than one row, or `data`
//                                        being neither null nor an array) —
//                                        NEVER guessed at, NEVER used to
//                                        issue a booking_access_token.
//
// Never logs the raw idempotency key, its hash, the full inserted/returned
// row, or any raw database error — callers only ever see one of the two
// stable outcome shapes above.
async function insertIdempotentDraft({ supabase, content, keyHash, requestHash }) {
  for (let attempt = 1; attempt <= MAX_ORDER_ID_ATTEMPTS; attempt++) {
    const candidateId = generateOrderId();

    const { data, error } = await supabase
      .from("orders")
      .upsert(
        {
          ...content,
          order_id: candidateId,
          payment_status: "draft",
          inventory_status: "pending",
          email_status: "pending",
          agent_idempotency_key_hash: keyHash,
          agent_idempotency_request_hash: requestHash,
        },
        { onConflict: "agent_idempotency_key_hash", ignoreDuplicates: true }
      )
      .select();

    if (error) {
      if (error.code !== UNIQUE_VIOLATION_CODE) {
        return { ok: false, code: AGENT_ERROR_CODES.DRAFT_CREATION_FAILED };
      }
      // order_id collided (unrelated to the idempotency key) — regenerate and retry.
      continue;
    }

    if (Array.isArray(data) && data.length === 1) {
      return { inserted: true, order: data[0] };
    }

    if (data === null || (Array.isArray(data) && data.length === 0)) {
      // Our row was not inserted because agent_idempotency_key_hash already
      // exists — that is the intended "duplicate delivery of the same
      // Idempotency-Key" outcome, not a failure. The caller resolves it by
      // reading the existing row.
      return { inserted: false };
    }

    // Anything else — multiple rows, or `data` is neither null nor an
    // array — is a response shape this code has no defined interpretation
    // for. Never guess which row (if any) is authoritative, and never
    // issue a token off an assumption: fail safely and stop.
    return { ok: false, code: AGENT_ERROR_CODES.DRAFT_CREATION_FAILED };
  }

  return { ok: false, code: AGENT_ERROR_CODES.DRAFT_CREATION_FAILED };
}

/**
 * @param {object} params
 * @param {object} params.supabase
 * @param {object} params.data - raw booking + contact fields; MUST NOT contain
 *   existing_order_id or order_id (rejected by validateDraftInput). total_price/
 *   deposit_amount/payment_status/inventory_status/stripe_session_id are never
 *   read from this object even if present.
 * @param {string} params.idempotencyKey - raw Idempotency-Key header value
 * @returns {Promise<{ok:true, ...} | {ok:false, code:string}>}
 */
async function createBookingDraftTool({ supabase, data, idempotencyKey }) {
  const validation = validateDraftInput(data || {});
  if (!validation.ok) {
    return validation;
  }

  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length === 0 ||
    idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    return { ok: false, code: AGENT_ERROR_CODES.INVALID_REQUEST };
  }

  // Fail closed on a missing token secret BEFORE any database write, so a
  // draft row is never created that this call could then not hand back a
  // usable booking_access_token for.
  const secretPreflight = issueBookingAccessToken({ order_id: "preflight-check-only" });
  if (!secretPreflight.ok && secretPreflight.code === AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED) {
    return { ok: false, code: AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED };
  }

  const keyHash = hashIdempotencyKey(idempotencyKey);
  const requestHash = computeFieldsHash(IDEMPOTENCY_REQUEST_FIELDS, data);

  const contentResult = await buildNormalizedContent({ supabase, raw: { ...data, source: "agent" } });
  if (!contentResult.ok) {
    return { ok: false, code: mapContentError(contentResult.error) };
  }

  const gate = await runAvailabilityGate({ supabase, content: contentResult.content });
  if (!gate.ok) return gate;

  const insertResult = await insertIdempotentDraft({ supabase, content: contentResult.content, keyHash, requestHash });
  if (insertResult.ok === false) {
    return insertResult;
  }

  let order;
  if (insertResult.inserted) {
    order = insertResult.order;
  } else {
    // Idempotency key already used — read the existing row and decide
    // same-request-replay (200, fresh token) vs different-request (409).
    const { data: existing, error: lookupErr } = await supabase
      .from("orders")
      .select("*")
      .eq("agent_idempotency_key_hash", keyHash)
      .maybeSingle();

    if (lookupErr) {
      return { ok: false, code: AGENT_ERROR_CODES.DRAFT_CREATION_FAILED };
    }
    if (!existing) {
      // Structurally should not happen — ON CONFLICT DO NOTHING firing
      // guarantees a committed row exists (see the function header) — but
      // never assume that at runtime; fail safely rather than throw.
      return { ok: false, code: AGENT_ERROR_CODES.INTERNAL_ERROR };
    }
    if (existing.agent_idempotency_request_hash !== requestHash) {
      return { ok: false, code: AGENT_ERROR_CODES.IDEMPOTENCY_CONFLICT };
    }
    order = existing;
  }

  const tokenResult = issueBookingAccessToken({ order_id: order.order_id });
  if (!tokenResult.ok) {
    return { ok: false, code: tokenResult.code };
  }

  return toOutput(order, tokenResult);
}

module.exports = { createBookingDraftTool, IDEMPOTENCY_REQUEST_FIELDS, hashIdempotencyKey };
