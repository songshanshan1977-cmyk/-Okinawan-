// lib/agent/errorCodes.js
//
// The complete, stable error-code enum for every Agent tool endpoint under
// pages/api/agent/*. Kept in one place so the set never silently drifts
// between endpoints, and so audit logs only ever contain one of these
// exact strings (see lib/agent/audit.js) — never a raw Supabase/Node error
// message, which could leak internal details (connection strings, table
// names, stack traces).
//
// Every code below is required by the A1 instructions even though not
// every one is reachable from every endpoint today (e.g. paid_order_immutable
// is only reachable from create-booking-draft's existing_order_id path).
// Listing them all here — rather than only defining the ones each endpoint
// happens to use — is what keeps "at least these codes must exist" true as
// a static, checkable fact rather than an implicit one.
const AGENT_ERROR_CODES = Object.freeze({
  AGENT_UNAUTHORIZED: "agent_unauthorized",
  AGENT_AUTH_NOT_CONFIGURED: "agent_auth_not_configured",
  INVALID_REQUEST: "invalid_request",
  INVENTORY_CHECK_FAILED: "inventory_check_failed",
  QUOTE_FAILED: "quote_failed",
  INVENTORY_UNAVAILABLE: "inventory_unavailable",
  DRAFT_CREATION_FAILED: "draft_creation_failed",
  PAID_ORDER_IMMUTABLE: "paid_order_immutable",
  BOOKING_ACCESS_INVALID: "booking_access_invalid",
  BOOKING_ACCESS_EXPIRED: "booking_access_expired",
  BOOKING_ACCESS_ORDER_MISMATCH: "booking_access_order_mismatch",
  ORDER_NOT_FOUND: "order_not_found",
  INTERNAL_ERROR: "internal_error",
});

// HTTP status mapping used uniformly by every pages/api/agent/*.js handler.
const AGENT_ERROR_STATUS = Object.freeze({
  [AGENT_ERROR_CODES.AGENT_UNAUTHORIZED]: 401,
  [AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED]: 500,
  [AGENT_ERROR_CODES.INVALID_REQUEST]: 400,
  [AGENT_ERROR_CODES.INVENTORY_CHECK_FAILED]: 500,
  [AGENT_ERROR_CODES.QUOTE_FAILED]: 400,
  [AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE]: 409,
  [AGENT_ERROR_CODES.DRAFT_CREATION_FAILED]: 500,
  [AGENT_ERROR_CODES.PAID_ORDER_IMMUTABLE]: 409,
  [AGENT_ERROR_CODES.BOOKING_ACCESS_INVALID]: 401,
  [AGENT_ERROR_CODES.BOOKING_ACCESS_EXPIRED]: 401,
  [AGENT_ERROR_CODES.BOOKING_ACCESS_ORDER_MISMATCH]: 401,
  [AGENT_ERROR_CODES.ORDER_NOT_FOUND]: 404,
  [AGENT_ERROR_CODES.INTERNAL_ERROR]: 500,
});

function statusForCode(code) {
  return AGENT_ERROR_STATUS[code] || 500;
}

module.exports = { AGENT_ERROR_CODES, AGENT_ERROR_STATUS, statusForCode };
