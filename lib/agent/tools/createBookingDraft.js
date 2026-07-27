// lib/agent/tools/createBookingDraft.js
//
// Agent tool: create_booking_draft — A1 closed-loop revision.
//
// A1-B01 (kept): this tool ONLY EVER creates a fresh, server-generated-id
// draft. `existing_order_id` and `order_id` are both REJECTED outright by
// lib/agent/validation/validateBookingInput.js's validateDraftInput() if
// present at all. Modifying an existing draft is out of scope for A1.
//
// Idempotent retry flow (this revision), matching the exact ordering the
// A1 close-out instructions specify:
//   1. validate the request shape (validateDraftInput)
//   2. validate the Idempotency-Key header shape
//   3. fail closed if AGENT_BOOKING_TOKEN_SECRET isn't configured, BEFORE
//      any database call
//   4. normalize the request (normalizeForIdempotencyHash — driver_lang to
//      ZH/JP, duration/pax/luggage to numbers, required text trimmed,
//      blank optional fields to null) and hash it, plus hash the raw
//      Idempotency-Key
//   5. PRE-CHECK: look up whether this Idempotency-Key already has an
//      order, by a whitelist SELECT (never select('*')) — this is a fast
//      path for "the Agent already succeeded once and is retrying after a
//      timeout": if found and the request hash matches, return the SAME
//      order_id and a FRESH token WITHOUT re-running price lookup,
//      availability, or any write. If found with a different request
//      hash, 409 idempotency_conflict immediately.
//   6. only if genuinely NOT found: compute price (buildNormalizedContent),
//      check availability, then attempt the ATOMIC idempotent insert
//      (INSERT ... ON CONFLICT (agent_idempotency_key_hash) DO NOTHING via
//      supabase-js .upsert(row, {onConflict, ignoreDuplicates: true})) —
//      this, not the pre-check, is what actually closes the race between
//      two concurrent requests carrying the same Idempotency-Key that both
//      passed the pre-check simultaneously. If this insert loses that
//      race, the losing call reads the real winner (same whitelist SELECT)
//      and resolves same-request-replay vs conflict the same way the
//      pre-check does.
//
// No in-process cache of any kind — every idempotency decision is made by
// reading/writing the database (orders.agent_idempotency_key_hash /
// agent_idempotency_request_hash + the named UNIQUE constraint
// orders_agent_idempotency_key_hash_key, see the migration). Never logs
// the raw idempotency key, its hash, a full row, or a raw database error.

const { checkAvailability } = require("../../inventory/checkAvailability");
const { buildNormalizedContent, normalizeDriverLang } = require("../../orders/normalizeOrderContent");
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
// payment_status/inventory_status/stripe_session_id (this tool never reads
// those off `data` in the first place, so they could not influence this
// hash even if a caller sent them). Hashed from the NORMALIZED form (see
// normalizeForIdempotencyHash) so two requests that differ only in
// formatting (driver_lang casing, numeric-vs-string duration, incidental
// whitespace) are correctly treated as the same request.
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

// Only the columns this tool actually needs back — every read of an
// existing/winning order row in this file uses this list, never select('*').
const ORDER_LOOKUP_COLUMNS = "order_id, payment_status, inventory_status, total_price, deposit_amount, agent_idempotency_request_hash";

function mapContentError(error) {
  return CONTENT_SHAPE_ERRORS.has(error) ? AGENT_ERROR_CODES.INVALID_REQUEST : AGENT_ERROR_CODES.QUOTE_FAILED;
}

function hashIdempotencyKey(rawKey) {
  return crypto.createHash("sha256").update(String(rawKey), "utf8").digest("hex");
}

function toNumberOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toTrimmedTextOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

// Canonicalizes the caller's raw input for HASHING purposes only — this is
// intentionally separate from lib/orders/normalizeOrderContent.js's
// buildNormalizedContent(), which governs what actually gets WRITTEN to
// the database (that PR #1 behavior — e.g. not trimming text — is frozen
// and untouched here). Two requests that mean the same thing but differ in
// raw formatting (driver_lang casing, "8" vs 8, incidental whitespace)
// must hash identically; validateDraftInput() has already confirmed every
// field here is well-formed by the time this runs.
function normalizeForIdempotencyHash(data) {
  return {
    car_model_id: data.car_model_id ?? null,
    driver_lang: normalizeDriverLang(data.driver_lang),
    duration: toNumberOrNull(data.duration),
    start_date: data.start_date ?? null,
    end_date: data.end_date ?? null,
    departure_hotel: toTrimmedTextOrNull(data.departure_hotel),
    end_hotel: toTrimmedTextOrNull(data.end_hotel),
    pax: toNumberOrNull(data.pax),
    luggage: toNumberOrNull(data.luggage),
    name: toTrimmedTextOrNull(data.name),
    phone: toTrimmedTextOrNull(data.phone),
    email: toTrimmedTextOrNull(data.email),
    wechat: toTrimmedTextOrNull(data.wechat),
    itinerary: toTrimmedTextOrNull(data.itinerary),
    remark: toTrimmedTextOrNull(data.remark),
  };
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

// Whitelist-only lookup of an order by its idempotency key hash — used
// both as the fast-path PRE-CHECK and as the post-conflict "who actually
// won the race" read. Never select('*').
async function lookupExistingDraftByKeyHash({ supabase, keyHash }) {
  const { data, error } = await supabase.from("orders").select(ORDER_LOOKUP_COLUMNS).eq("agent_idempotency_key_hash", keyHash).maybeSingle();

  if (error) {
    return { ok: false, code: AGENT_ERROR_CODES.DRAFT_CREATION_FAILED };
  }
  return { ok: true, existing: data || null };
}

// Attempts the atomic idempotent insert, retrying only on an order_id
// collision (a DIFFERENT unique constraint than the one this statement's
// ON CONFLICT target names, so it surfaces as a real 23505 error rather
// than being silently absorbed). Returns:
//   {inserted: true,  order: <row>}   — this call created the row (exactly
//                                        one row came back)
//   {inserted: false}                 — the idempotency key already had a
//                                        row (ON CONFLICT DO NOTHING fired,
//                                        `data` came back null or []) —
//                                        caller must read it separately
//   {ok: false, code: ...}            — a real failure: a database error,
//                                        OR a response shape this code has
//                                        no defined interpretation for
//                                        (more than one row, or `data`
//                                        being neither null nor an array) —
//                                        NEVER guessed at, NEVER used to
//                                        issue a booking_access_token.
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
      .select(ORDER_LOOKUP_COLUMNS);

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
      return { inserted: false };
    }

    // Multiple rows, or `data` is neither null nor an array — a response
    // shape this code has no defined interpretation for. Never guess, never
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

  // Fail closed on a missing token secret BEFORE any database call at all.
  const secretPreflight = issueBookingAccessToken({ order_id: "preflight-check-only" });
  if (!secretPreflight.ok && secretPreflight.code === AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED) {
    return { ok: false, code: AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED };
  }

  const keyHash = hashIdempotencyKey(idempotencyKey);
  const requestHash = computeFieldsHash(IDEMPOTENCY_REQUEST_FIELDS, normalizeForIdempotencyHash(data));

  // Fast path: has this exact Idempotency-Key already produced an order?
  const preCheck = await lookupExistingDraftByKeyHash({ supabase, keyHash });
  if (!preCheck.ok) return preCheck;

  let order;

  if (preCheck.existing) {
    if (preCheck.existing.agent_idempotency_request_hash !== requestHash) {
      return { ok: false, code: AGENT_ERROR_CODES.IDEMPOTENCY_CONFLICT };
    }
    // Same key, same (normalized) request: this is a retry of an already-
    // completed call. No price lookup, no availability check, no write.
    order = preCheck.existing;
  } else {
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

    if (insertResult.inserted) {
      order = insertResult.order;
    } else {
      // Lost a genuine concurrent race between our pre-check and our own
      // insert attempt — read whichever row actually won.
      const raceLookup = await lookupExistingDraftByKeyHash({ supabase, keyHash });
      if (!raceLookup.ok) return raceLookup;
      if (!raceLookup.existing) {
        // Structurally should not happen — ON CONFLICT DO NOTHING firing
        // guarantees a committed row exists — but never assume that at
        // runtime; fail safely rather than throw.
        return { ok: false, code: AGENT_ERROR_CODES.INTERNAL_ERROR };
      }
      if (raceLookup.existing.agent_idempotency_request_hash !== requestHash) {
        return { ok: false, code: AGENT_ERROR_CODES.IDEMPOTENCY_CONFLICT };
      }
      order = raceLookup.existing;
    }
  }

  const tokenResult = issueBookingAccessToken({ order_id: order.order_id });
  if (!tokenResult.ok) {
    return { ok: false, code: tokenResult.code };
  }

  return toOutput(order, tokenResult);
}

module.exports = { createBookingDraftTool, IDEMPOTENCY_REQUEST_FIELDS, hashIdempotencyKey, normalizeForIdempotencyHash };
