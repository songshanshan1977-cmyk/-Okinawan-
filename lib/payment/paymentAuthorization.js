// lib/payment/paymentAuthorization.js
//
// A3: issues the short-lived, one-time, database-stateful payment
// authorization that pages/api/create-payment-intent.js (web) and
// lib/agent/tools/createPaymentLink.js (Agent) must both hold before either
// may ever create a Stripe Checkout Session. This is the ONLY place that
// writes the five payment_authorization_* columns on `orders` (see
// supabase/migrations/20260729120000_payment_authorization_v1.sql) —
// lib/payment/createCheckoutSession.js only ever CONSUMES what this module
// issues, via the atomic consume_payment_authorization_v1 RPC, never writes
// these columns itself.
//
// Design constraints (from the A3 instructions):
//   - the raw token is at least 32 random bytes, generated with a
//     cryptographically-safe generator (crypto.randomBytes), never Math.random();
//   - the raw token is NEVER stored anywhere — only its SHA-256 hash;
//   - the bound summary_hash is computed with the exact same shared
//     algorithm every other Agent tool uses (lib/agent/bookingSummary.js's
//     computeSummaryHash) — no second hash implementation;
//   - the bound deposit amount is always the fixed business constant (500),
//     never whatever happens to be on the row, so a future drift in
//     order.deposit_amount can never silently authorize a different amount;
//   - each order has AT MOST one current authorization: issuing a new one
//     unconditionally overwrites all five columns in a single UPDATE, which
//     immediately invalidates any previously-issued raw token for that
//     order (its hash can no longer match what's stored);
//   - default validity: 10 minutes;
//   - this module never logs the raw token, its hash, or any PII — on
//     failure it returns a stable error code only.

const crypto = require("crypto");
const { computeSummaryHash } = require("../agent/bookingSummary");
const { FIXED_DEPOSIT_AMOUNT } = require("../orders/normalizeOrderContent");
const { AGENT_ERROR_CODES } = require("../agent/errorCodes");

const TOKEN_BYTES = 32; // >= 32 bytes random, per instructions
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

function generateRawToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

function hashPaymentToken(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken), "utf8").digest("hex");
}

/**
 * @param {object} params
 * @param {object} params.supabase
 * @param {object} params.order - must contain every lib/agent/bookingSummary.js
 *   HASHED_FIELDS column (order_id, start_date, end_date, car_model_id,
 *   driver_lang, duration, pax, luggage, departure_hotel, end_hotel,
 *   total_price, deposit_amount) — callers already have this row from their
 *   own read/insert/update, this function never re-reads the order itself.
 * @param {number} [params.ttlMs]
 * @returns {Promise<{ok:true, token:string, expires_at:string} | {ok:false, code:string}>}
 */
async function issuePaymentAuthorization({ supabase, order, ttlMs = DEFAULT_TTL_MS }) {
  if (!order || !order.order_id || typeof order.order_id !== "string") {
    return { ok: false, code: AGENT_ERROR_CODES.INVALID_REQUEST };
  }

  const rawToken = generateRawToken();
  const tokenHash = hashPaymentToken(rawToken);
  const summaryHash = computeSummaryHash(order);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const { data, error } = await supabase
    .from("orders")
    .update({
      payment_authorization_token_hash: tokenHash,
      payment_authorization_summary_hash: summaryHash,
      payment_authorization_deposit_amount: FIXED_DEPOSIT_AMOUNT,
      payment_authorization_expires_at: expiresAt,
      payment_authorization_consumed_at: null,
    })
    .eq("order_id", order.order_id)
    .select("order_id");

  if (error) {
    return { ok: false, code: AGENT_ERROR_CODES.PAYMENT_AUTHORIZATION_FAILED };
  }
  if (!Array.isArray(data) || data.length !== 1) {
    // Response shape this code has no defined interpretation for — never
    // guess, never hand back a raw token unless the write is confirmed.
    return { ok: false, code: AGENT_ERROR_CODES.PAYMENT_AUTHORIZATION_FAILED };
  }

  return { ok: true, token: rawToken, expires_at: expiresAt };
}

module.exports = { issuePaymentAuthorization, hashPaymentToken, DEFAULT_TTL_MS, TOKEN_BYTES };
