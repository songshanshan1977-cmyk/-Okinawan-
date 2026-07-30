// lib/payment/paymentAuthorization.js
//
// A3: issues the short-lived, one-time, database-stateful payment
// authorization that pages/api/create-payment-intent.js (web) and
// lib/agent/tools/createPaymentLink.js (Agent) must both hold before either
// may ever create a Stripe Checkout Session. This is the ONLY place that
// (re-)issues an authorization — via the atomic issue_payment_authorization_v1
// RPC, never a plain application-level UPDATE (see
// supabase/migrations/20260729120000_payment_authorization_v1.sql for why a
// plain UPDATE cannot safely decide "keep the existing payment_attempt_id vs
// mint a new one" under concurrent issuance). lib/payment/createCheckoutSession.js
// only ever CONSUMES what this module issues, via the atomic
// consume_payment_authorization_v1 RPC, never writes these columns itself.
//
// Payment-attempt idempotency (this revision): the raw token/token hash are
// ALWAYS freshly minted on every call, but the authoritative
// payment_attempt_id is decided ATOMICALLY by the RPC itself — issuing again
// for the SAME order_id + SAME summary_hash while the order is still
// draft/pending preserves the existing payment_attempt_id rather than
// minting a new one. That attempt id becomes the Stripe idempotency key
// lib/payment/createCheckoutSession.js uses, which is what lets a retried
// call recover the same Checkout Session instead of creating a second one.
// This module only generates a CANDIDATE attempt id (crypto.randomUUID()) —
// the RPC alone decides whether it's actually used.
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
//   - default validity: 10 minutes;
//   - this module never logs the raw token, its hash, the attempt id, or any
//     PII — on failure it returns a stable error code only.

const crypto = require("crypto");
const { computeSummaryHash } = require("../agent/bookingSummary");
const { FIXED_DEPOSIT_AMOUNT } = require("../orders/normalizeOrderContent");
const { AGENT_ERROR_CODES } = require("../agent/errorCodes");

const TOKEN_BYTES = 32; // >= 32 bytes random, per instructions
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const ISSUE_RPC_NAME = "issue_payment_authorization_v1";

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
 * @returns {Promise<{ok:true, token:string, expires_at:string, payment_attempt_id:string} | {ok:false, code:string}>}
 */
async function issuePaymentAuthorization({ supabase, order, ttlMs = DEFAULT_TTL_MS }) {
  if (!order || !order.order_id || typeof order.order_id !== "string") {
    return { ok: false, code: AGENT_ERROR_CODES.INVALID_REQUEST };
  }

  const rawToken = generateRawToken();
  const tokenHash = hashPaymentToken(rawToken);
  const summaryHash = computeSummaryHash(order);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const candidateAttemptId = crypto.randomUUID();

  const { data, error } = await supabase.rpc(ISSUE_RPC_NAME, {
    p_order_id: order.order_id,
    p_token_hash: tokenHash,
    p_candidate_attempt_id: candidateAttemptId,
    p_summary_hash: summaryHash,
    p_deposit_amount: FIXED_DEPOSIT_AMOUNT,
    p_expires_at: expiresAt,
  });

  if (error) {
    return { ok: false, code: AGENT_ERROR_CODES.PAYMENT_AUTHORIZATION_FAILED };
  }
  if (!Array.isArray(data) || data.length !== 1 || !data[0].payment_attempt_id) {
    // Response shape this code has no defined interpretation for — never
    // guess, never hand back a raw token unless the write is confirmed.
    return { ok: false, code: AGENT_ERROR_CODES.PAYMENT_AUTHORIZATION_FAILED };
  }

  return { ok: true, token: rawToken, expires_at: expiresAt, payment_attempt_id: data[0].payment_attempt_id };
}

module.exports = { issuePaymentAuthorization, hashPaymentToken, DEFAULT_TTL_MS, TOKEN_BYTES, ISSUE_RPC_NAME };
