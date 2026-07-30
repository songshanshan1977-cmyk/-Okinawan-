// lib/payment/createCheckoutSession.js
//
// A3: the ONE shared function that turns a (order_id, raw payment_token)
// pair into a Stripe Checkout Session. Both pages/api/create-payment-intent.js
// (web) and lib/agent/tools/createPaymentLink.js (Agent) call this directly
// — never through an internal HTTP hop — so the two surfaces can never drift
// into two different consumption/verification rules.
//
// Flow (every step required, in this order):
//   1. hash the raw token, call the atomic consume_payment_authorization_v1
//      RPC (supabase/migrations/20260729120000_payment_authorization_v1.sql)
//      — this is the ONLY step that consumes the authorization. No
//      "SELECT then UPDATE" anywhere in this file.
//   2. no matching row (wrong order_id, wrong token, already consumed, or
//      expired) -> payment_authorization_expired_or_used, zero Stripe calls.
//   3. recompute the CURRENT summary_hash (lib/agent/bookingSummary.js) from
//      the RPC's own returned row and compare it against the hash the
//      authorization was bound to at issuance -> payment_summary_stale on
//      mismatch, zero Stripe calls.
//   4. re-verify the bound deposit amount equals both the order's current
//      deposit_amount AND the fixed business constant (500) ->
//      payment_summary_stale on mismatch, zero Stripe calls.
//   5. re-check full-range inventory availability -> inventory_unavailable
//      on any unavailable date, zero Stripe calls.
//   6. create (or, via Stripe's own idempotency, RESUME) the Stripe Checkout
//      Session — see "Payment-attempt idempotency" below.
//   7. write stripe_session_id + payment_status=pending back onto the order,
//      AND VERIFY that write actually landed (see "Write-back verification"
//      below) before ever reporting success.
//
// Payment-attempt idempotency: the Stripe call is made with
// `{ idempotencyKey: "checkout:" + consumedOrder.payment_attempt_id }`.
// payment_attempt_id is decided ATOMICALLY by
// lib/payment/paymentAuthorization.js's issue_payment_authorization_v1 RPC —
// the SAME order_id + SAME summary_hash always yields the SAME attempt id
// while the order stays draft/pending, so a retried request (a customer
// double-click, an Agent timeout retry, two genuinely concurrent requests)
// reuses the exact same idempotency key. Stripe itself then guarantees at
// most one real Checkout Session is ever created for that key+params pair —
// every retry gets back the SAME session id/url instead of a new one. This
// is also why every field in the `stripe.checkout.sessions.create(...)`
// params below MUST be deterministic from consumedOrder alone (never a raw
// token, a random value, or anything that could differ between retries of
// the same attempt) — Stripe treats a same-key-different-params retry as an
// error, and this file relies on params staying byte-identical across
// retries of the same attempt.
//
// Once step 1 consumes the authorization, the TOKEN is never restored —
// not on a stale-summary rejection, not on inventory failure, not on a
// Stripe error, not on a write-back failure. This remains a deliberate,
// documented non-goal: no "processing lease" or complex state machine this
// round. But because the Stripe call itself is idempotency-keyed on
// payment_attempt_id (not on the consumed token), a caller who re-issues a
// FRESH authorization for the same order_id + same summary_hash (which
// preserves the same payment_attempt_id, per the RPC's own rule) and retries
// this whole function will recover the SAME Stripe Session rather than
// creating a second one — this is exactly how a Stripe-success-but-write-
// back-failure is safely retried to completion.
//
// Write-back verification: after Stripe returns a session, this file does
// NOT trust that the write-back UPDATE succeeded just because it didn't
// throw — it re-selects the row it just wrote and checks: zero DB error,
// exactly one row, that row's stripe_session_id matches the session Stripe
// just returned, and that row's payment_status is "pending". Any mismatch
// -> payment_session_write_failed, and this function does NOT return a
// success URL (the customer must not be shown a link this backend cannot
// confirm the database agrees with — a retry, safe per the idempotency
// guarantee above, is required instead).
//
// Never logs the raw token, the token hash, a summary_hash, the attempt id,
// a full order row, or a Stripe/Supabase secret — every failure returns one
// of the stable AGENT_ERROR_CODES only.

const { hashPaymentToken } = require("./paymentAuthorization");
const { computeSummaryHash } = require("../agent/bookingSummary");
const { FIXED_DEPOSIT_AMOUNT } = require("../orders/normalizeOrderContent");
const { checkAvailability } = require("../inventory/checkAvailability");
const { AGENT_ERROR_CODES } = require("../agent/errorCodes");

const RPC_NAME = "consume_payment_authorization_v1";
const DEPOSIT_PRODUCT_NAME = "冲绳包车押金";
const STRIPE_IDEMPOTENCY_KEY_PREFIX = "checkout:";

function getSiteUrlFromEnv() {
  const u = (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "").trim();
  return u ? u.replace(/\/$/, "") : "";
}

function buildUrls(siteUrl, order_id) {
  return {
    successUrl: `${siteUrl}/booking?step=5&order_id=${encodeURIComponent(order_id)}`,
    cancelUrl: `${siteUrl}/booking?step=4&order_id=${encodeURIComponent(order_id)}`,
  };
}

/**
 * @param {object} params
 * @param {object} params.supabase
 * @param {object} params.stripe - a constructed Stripe client (injected so
 *   both callers, and tests, control it — this function never constructs
 *   its own Stripe instance)
 * @param {string} params.order_id
 * @param {string} params.payment_token - the RAW one-time token; hashed
 *   here and never logged
 * @returns {Promise<
 *   {ok:true, order_id:string, url:string, stripe_session_id:string, payment_status:"pending"}
 *   | {ok:false, code:string, unavailable_dates?:Array}
 * >}
 */
async function createCheckoutSession({ supabase, stripe, order_id, payment_token }) {
  if (!order_id || typeof order_id !== "string" || !payment_token || typeof payment_token !== "string") {
    return { ok: false, code: AGENT_ERROR_CODES.INVALID_REQUEST };
  }

  const siteUrl = getSiteUrlFromEnv();
  if (!siteUrl) {
    return { ok: false, code: AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED };
  }

  const tokenHash = hashPaymentToken(payment_token);

  const { data, error } = await supabase.rpc(RPC_NAME, { p_order_id: order_id, p_token_hash: tokenHash });

  if (error) {
    return { ok: false, code: AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED };
  }
  if (!Array.isArray(data) || data.length === 0) {
    return { ok: false, code: AGENT_ERROR_CODES.PAYMENT_AUTHORIZATION_EXPIRED_OR_USED };
  }
  if (data.length > 1) {
    // A response shape this code has no defined interpretation for — never
    // guess which row is authoritative.
    return { ok: false, code: AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED };
  }

  const consumedOrder = data[0];

  const liveSummaryHash = computeSummaryHash(consumedOrder);
  if (liveSummaryHash !== consumedOrder.payment_authorization_summary_hash) {
    return { ok: false, code: AGENT_ERROR_CODES.PAYMENT_SUMMARY_STALE };
  }

  const boundDeposit = Number(consumedOrder.payment_authorization_deposit_amount);
  if (Number(consumedOrder.deposit_amount) !== boundDeposit || boundDeposit !== FIXED_DEPOSIT_AMOUNT) {
    return { ok: false, code: AGENT_ERROR_CODES.PAYMENT_SUMMARY_STALE };
  }

  const availability = await checkAvailability({
    supabase,
    start_date: consumedOrder.start_date,
    end_date: consumedOrder.end_date,
    car_model_id: consumedOrder.car_model_id,
    driver_lang: consumedOrder.driver_lang,
  });

  if (!availability.ok) {
    return { ok: false, code: AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED };
  }
  if (!availability.available) {
    return { ok: false, code: AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE, unavailable_dates: availability.unavailable_dates };
  }

  if (!consumedOrder.payment_attempt_id || typeof consumedOrder.payment_attempt_id !== "string") {
    // Should be structurally impossible (the CHECK constraint requires
    // payment_attempt_id whenever an authorization exists at all), but never
    // build a Stripe idempotency key off a value that isn't confirmed present.
    return { ok: false, code: AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED };
  }

  const { successUrl, cancelUrl } = buildUrls(siteUrl, consumedOrder.order_id);
  const idempotencyKey = `${STRIPE_IDEMPOTENCY_KEY_PREFIX}${consumedOrder.payment_attempt_id}`;

  let session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card", "alipay"],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "cny",
              unit_amount: Math.round(FIXED_DEPOSIT_AMOUNT * 100),
              product_data: { name: DEPOSIT_PRODUCT_NAME },
            },
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: consumedOrder.order_id,
        metadata: { order_id: consumedOrder.order_id },
      },
      { idempotencyKey }
    );
  } catch (e) {
    // The authorization was already consumed above and is NOT restored here
    // — a documented non-goal for this round (see file header). A caller
    // that re-issues a fresh authorization for the same order+summary will
    // retry with the SAME idempotencyKey and safely resume this same attempt.
    return { ok: false, code: AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED };
  }

  if (!session || !session.id || !session.url) {
    // A Stripe response this code has no defined interpretation for — never
    // report success off an incomplete session object.
    return { ok: false, code: AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED };
  }

  const { data: writeBack, error: writeBackErr } = await supabase
    .from("orders")
    .update({ stripe_session_id: session.id, payment_status: "pending" })
    .eq("order_id", consumedOrder.order_id)
    .select("order_id, stripe_session_id, payment_status");

  if (writeBackErr) {
    return { ok: false, code: AGENT_ERROR_CODES.PAYMENT_SESSION_WRITE_FAILED };
  }
  if (!Array.isArray(writeBack) || writeBack.length !== 1) {
    return { ok: false, code: AGENT_ERROR_CODES.PAYMENT_SESSION_WRITE_FAILED };
  }
  const written = writeBack[0];
  if (written.stripe_session_id !== session.id || written.payment_status !== "pending") {
    return { ok: false, code: AGENT_ERROR_CODES.PAYMENT_SESSION_WRITE_FAILED };
  }

  return { ok: true, order_id: consumedOrder.order_id, url: session.url, stripe_session_id: session.id, payment_status: "pending" };
}

module.exports = { createCheckoutSession, getSiteUrlFromEnv, RPC_NAME, STRIPE_IDEMPOTENCY_KEY_PREFIX };
