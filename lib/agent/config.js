// lib/agent/config.js
//
// Shared secret-configuration validation for the two independent Agent
// auth layers (lib/agent/auth/verifyAgentService.js's AGENT_SERVICE_KEY and
// lib/agent/tokens/bookingAccessToken.js's AGENT_BOOKING_TOKEN_SECRET).
//
// Two hardening rules, both fail-closed (a rejected value is treated
// identically to "not configured at all" — never falls back to any
// default):
//   1. a production-grade secret must be at least MIN_SECRET_LENGTH bytes —
//      a short value (a placeholder someone forgot to replace, a typo'd
//      single word) is rejected outright, never silently accepted as "at
//      least something";
//   2. the two secrets must never be equal to each other — this is a
//      two-layer authorization design specifically so that possessing one
//      secret does not grant the other; if they were accidentally set to
//      the same value, that separation is void, so BOTH are treated as
//      unconfigured rather than silently allowing a single secret to do
//      double duty.
//
// Deliberately reads process.env directly (not injected) so every call
// site sees the real current environment, matching the existing posture in
// verifyAgentService.js / bookingAccessToken.js.

const MIN_SECRET_LENGTH = 32; // bytes

function byteLength(v) {
  return Buffer.byteLength(String(v), "utf8");
}

/**
 * @param {string} varName - the env var name to read and validate
 * @param {string} otherVarName - the OTHER Agent secret's env var name, to check against
 * @returns {string|null} the validated secret value, or null if unconfigured/too short/equal to the other secret
 */
function getValidatedAgentSecret(varName, otherVarName) {
  const value = process.env[varName];
  if (!value || String(value).trim().length === 0) return null;
  if (byteLength(value) < MIN_SECRET_LENGTH) return null;

  const other = process.env[otherVarName];
  if (other && String(other).trim().length > 0 && value === other) return null;

  return value;
}

module.exports = { getValidatedAgentSecret, MIN_SECRET_LENGTH };
