// lib/agent/tokens/bookingAccessToken.js
//
// Short-lived, HMAC-SHA256-signed token that binds a single order_id to
// the right to read that order's whitelisted summary via
// pages/api/agent/get-booking-summary.js. Issued by create-booking-draft,
// consumed by get-booking-summary. This is explicitly NOT a payment token
// — it grants read access to one order's non-payment summary fields only,
// nothing else, and pages/api/agent/*.js never treats its presence as
// authorization to charge, confirm, or mutate anything.
//
// Token shape: `${payloadB64url}.${hmacHex}`
//   payload = { order_id, purpose: "booking_access", issued_at, expires_at }
//   hmacHex = HMAC-SHA256(secret, payloadB64url), hex-encoded
//
// Secret comes ONLY from process.env.AGENT_BOOKING_TOKEN_SECRET, validated
// by lib/agent/config.js's getValidatedAgentSecret — missing, blank,
// shorter than 32 bytes, OR equal to AGENT_SERVICE_KEY all fail closed on
// both sign() and verify(), same posture as lib/agent/auth/verifyAgentService.js.

const crypto = require("crypto");
const { AGENT_ERROR_CODES } = require("../errorCodes");
const { getValidatedAgentSecret } = require("../config");

const PURPOSE = "booking_access";
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

function base64url(input) {
  return Buffer.from(input, "utf8").toString("base64url");
}

function fromBase64url(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function getSecret() {
  return getValidatedAgentSecret("AGENT_BOOKING_TOKEN_SECRET", "AGENT_SERVICE_KEY");
}

function sign(payloadB64, secret) {
  return crypto.createHmac("sha256", secret).update(payloadB64, "utf8").digest();
}

/**
 * @param {object} params
 * @param {string} params.order_id
 * @param {number} [params.ttlMs]
 * @returns {{ok:true, token:string, issued_at:number, expires_at:number} | {ok:false, code:string}}
 */
function issueBookingAccessToken({ order_id, ttlMs = DEFAULT_TTL_MS }) {
  const secret = getSecret();
  if (!secret) {
    return { ok: false, code: AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED };
  }
  if (!order_id) {
    return { ok: false, code: AGENT_ERROR_CODES.INVALID_REQUEST };
  }

  const issued_at = Date.now();
  const expires_at = issued_at + ttlMs;
  const payloadB64 = base64url(JSON.stringify({ order_id, purpose: PURPOSE, issued_at, expires_at }));
  const signature = sign(payloadB64, secret).toString("hex");

  return { ok: true, token: `${payloadB64}.${signature}`, issued_at, expires_at };
}

/**
 * @param {object} params
 * @param {string} params.token
 * @param {string} params.order_id - the order_id the caller is asking about;
 *   must match the token's bound order_id exactly.
 * @returns {{ok:true, payload:object} | {ok:false, code:string}}
 */
function verifyBookingAccessToken({ token, order_id }) {
  const secret = getSecret();
  if (!secret) {
    return { ok: false, code: AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED };
  }

  if (!token || typeof token !== "string" || token.indexOf(".") === -1) {
    return { ok: false, code: AGENT_ERROR_CODES.BOOKING_ACCESS_INVALID };
  }

  const dotIndex = token.lastIndexOf(".");
  const payloadB64 = token.slice(0, dotIndex);
  const providedSigHex = token.slice(dotIndex + 1);

  let providedSig;
  try {
    providedSig = Buffer.from(providedSigHex, "hex");
  } catch (e) {
    return { ok: false, code: AGENT_ERROR_CODES.BOOKING_ACCESS_INVALID };
  }

  const expectedSig = sign(payloadB64, secret);
  // HMAC-SHA256 digests are always 32 bytes on both sides, so a direct
  // timingSafeEqual is safe here without the digest-first normalization
  // verifyAgentService.js needs for arbitrary-length secrets — but an
  // attacker-controlled hex string could still be the wrong length, which
  // would make timingSafeEqual throw rather than return false, so that
  // case is checked explicitly first.
  if (providedSig.length !== expectedSig.length || !crypto.timingSafeEqual(providedSig, expectedSig)) {
    return { ok: false, code: AGENT_ERROR_CODES.BOOKING_ACCESS_INVALID };
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64url(payloadB64));
  } catch (e) {
    return { ok: false, code: AGENT_ERROR_CODES.BOOKING_ACCESS_INVALID };
  }

  if (!payload || payload.purpose !== PURPOSE || !payload.order_id || !payload.expires_at) {
    return { ok: false, code: AGENT_ERROR_CODES.BOOKING_ACCESS_INVALID };
  }

  if (Date.now() > Number(payload.expires_at)) {
    return { ok: false, code: AGENT_ERROR_CODES.BOOKING_ACCESS_EXPIRED };
  }

  if (String(payload.order_id) !== String(order_id)) {
    return { ok: false, code: AGENT_ERROR_CODES.BOOKING_ACCESS_ORDER_MISMATCH };
  }

  return { ok: true, payload };
}

module.exports = { issueBookingAccessToken, verifyBookingAccessToken, PURPOSE, DEFAULT_TTL_MS };
