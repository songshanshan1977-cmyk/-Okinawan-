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
//   6. create the Stripe Checkout Session (fixed 500 RMB deposit).
//   7. write stripe_session_id + payment_status=pending back onto the order.
//
// Once step 1 consumes the authorization, it is NEVER restored — not on a
// stale-summary rejection, not on inventory failure, not on a Stripe error.
// This is a deliberate, documented non-goal: no "processing lease" or retry
// state machine this round. A caller whose Stripe call fails after
// consumption must have a fresh authorization issued and try again.
//
// Never logs the raw token, the token hash, a summary_hash, a full order
// row, or a Stripe/Supabase secret — every failure returns one of the
// stable AGENT_ERROR_CODES only.

const { hashPaymentToken } = require("./paymentAuthorization");
const { computeSummaryHash } = require("../agent/bookingSummary");
const { FIXED_DEPOSIT_AMOUNT } = require("../orders/normalizeOrderContent");
const { checkAvailability } = require("../inventory/checkAvailability");
const { AGENT_ERROR_CODES } = require("../agent/errorCodes");

const RPC_NAME = "consume_payment_authorization_v1";
const DEPOSIT_PRODUCT_NAME = "冲绳包车押金";

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

  const { successUrl, cancelUrl } = buildUrls(siteUrl, consumedOrder.order_id);

  let session;
  try {
    session = await stripe.checkout.sessions.create({
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
    });
  } catch (e) {
    // The authorization was already consumed above and is NOT restored here
    // — a documented non-goal for this round (see file header).
    return { ok: false, code: AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED };
  }

  await supabase
    .from("orders")
    .update({ stripe_session_id: session.id, payment_status: "pending" })
    .eq("order_id", consumedOrder.order_id);

  return { ok: true, order_id: consumedOrder.order_id, url: session.url, stripe_session_id: session.id, payment_status: "pending" };
}

module.exports = { createCheckoutSession, getSiteUrlFromEnv, RPC_NAME };
