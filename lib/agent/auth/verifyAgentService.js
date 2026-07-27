// lib/agent/auth/verifyAgentService.js
//
// Service-level authentication for every pages/api/agent/*.js endpoint.
// This is the OUTER layer: it authenticates the Agent orchestration
// backend itself as a legitimate caller of these endpoints at all. It is
// completely separate from, and checked before, the per-order
// booking_access_token (lib/agent/tokens/bookingAccessToken.js) — that
// second layer authorizes access to one specific order, not the caller's
// right to reach these endpoints in the first place.
//
// Design constraints (from the A1 instructions):
//   - reads a plain `Authorization: Bearer <token>` header, nothing else;
//   - the expected value comes ONLY from process.env.AGENT_SERVICE_KEY,
//     validated by lib/agent/config.js's getValidatedAgentSecret — missing,
//     blank, shorter than 32 bytes, OR equal to AGENT_BOOKING_TOKEN_SECRET
//     all fail CLOSED (agent_auth_not_configured), never falling back to
//     any default/dev key;
//   - comparison is timing-safe regardless of the two strings' lengths
//     (crypto.timingSafeEqual throws on a raw length mismatch, so both
//     sides are hashed to a fixed-length digest first — a standard pattern
//     for timing-safe comparison of variable-length secrets);
//   - the raw header value is never returned, logged, or embedded in any
//     error payload — callers only ever see one of the two stable outcome
//     codes.

const crypto = require("crypto");
const { AGENT_ERROR_CODES } = require("../errorCodes");
const { getValidatedAgentSecret } = require("../config");

function digest(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest();
}

function timingSafeStringEqual(a, b) {
  const da = digest(a);
  const db = digest(b);
  return crypto.timingSafeEqual(da, db);
}

function extractBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== "string") return null;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/);
  return match ? match[1].trim() : null;
}

/**
 * @param {object} req - Next.js API request (only req.headers is read)
 * @returns {{ok:true} | {ok:false, code: string}}
 */
function verifyAgentService(req) {
  const expected = getValidatedAgentSecret("AGENT_SERVICE_KEY", "AGENT_BOOKING_TOKEN_SECRET");
  if (!expected) {
    return { ok: false, code: AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED };
  }

  const header = req && req.headers ? req.headers.authorization : undefined;
  const token = extractBearerToken(header);
  if (!token || token.length === 0) {
    return { ok: false, code: AGENT_ERROR_CODES.AGENT_UNAUTHORIZED };
  }

  if (!timingSafeStringEqual(token, expected)) {
    return { ok: false, code: AGENT_ERROR_CODES.AGENT_UNAUTHORIZED };
  }

  return { ok: true };
}

module.exports = { verifyAgentService, extractBearerToken, timingSafeStringEqual };
