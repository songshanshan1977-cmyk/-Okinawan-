// lib/public/agentCapabilities.js
//
// Public, unauthenticated "who are we / what tools exist / how do they fit
// together" discovery document for external Agents. This is a DESCRIPTION
// of the already-shipped A1/A2/A3 Agent tool surface — it does not add,
// change, or re-authorize anything. The 8 tools listed below are exactly
// the 8 pages/api/agent/*.js endpoints that exist today; no invented tool
// (e.g. a vehicle-recommendation or human-handover tool) is included.
//
// Read-only reference sources for every field below (never re-derived from
// memory, always the real files):
//   lib/agent/errorCodes.js
//   lib/agent/auth/verifyAgentService.js
//   lib/agent/tokens/bookingAccessToken.js
//   pages/api/agent/*.js (all 8) and lib/agent/tools/*.js (all 8)
//
// No Secret, no real Bearer/token value, no database column, no internal
// contact address, and no retired brand name ever appears here — same
// constraint lib/public/serviceFacts.js already enforces.

const { SERVICE_FACTS_VERSION } = require("./serviceFacts");

const AGENT_CAPABILITIES_VERSION = "2026-08-02-v1";

const BASE_URL = "https://booking.xn--okinawa-n14kh45a.com";

// Recursively freezes a plain data object/array — same pattern
// lib/public/serviceFacts.js already uses, reused here rather than
// re-implemented.
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
  }
  return value;
}

const identity = {
  brand: "华人Okinawa",
  service_area: "Okinawa, Japan",
  service_facts_url: `${BASE_URL}/api/public/service-facts`,
};

const discovery = {
  capabilities_url: `${BASE_URL}/api/public/agent-capabilities`,
  openapi_url: `${BASE_URL}/api/public/openapi`,
};

const access = {
  public_information: "unauthenticated",
  transaction_tools: "partner_authorization_required",
  self_service_registration: false,
  access_contact: "huarenokinawa2025@gmail.com",
  notes: [
    "Any Agent may read the public service-facts, agent-capabilities, and openapi documents without authentication.",
    "The 8 transactional tools below cannot be called anonymously — every call requires a valid partner service credential.",
    "An unknown Agent cannot guess, derive, or self-issue that credential; there is no self-service signup or key-generation endpoint.",
    "Real integration requires separate, out-of-band authorization arranged directly with 华人Okinawa via access_contact.",
    "This document never returns a real key, secret, or token value — every credential example elsewhere is a placeholder only.",
  ],
};

const auth_model = {
  AgentServiceBearer: {
    header: "Authorization: Bearer <partner credential>",
    purpose: "Service-level authentication of the partner Agent backend itself. Required by all 8 transactional tools. Verified against a server-side secret only; no real value is ever disclosed here.",
  },
  BookingAccessToken: {
    header: "X-Booking-Access-Token",
    purpose: "Order-scoped access token issued by create_booking_draft, bound to one order_id. Required in addition to AgentServiceBearer by every tool that reads or acts on an already-created order (get_booking_summary, update_booking_draft, confirm_booking_summary, create_payment_link, get_payment_status). Short-lived; not a payment authorization.",
  },
  "Idempotency-Key": {
    header: "Idempotency-Key",
    purpose: "Caller-generated key required only by create_booking_draft, to make retrying a draft-creation call safe. The same key must never be reused for a request with different content.",
  },
};

const workflow = {
  steps: [
    { step: 1, tool: "read_service_facts", note: "Read public reference facts (prices, capacity, contact, policy) before proposing anything to the customer." },
    { step: 2, tool: "check_availability", note: "Confirm the requested car model / dates / driver language are available." },
    { step: 3, tool: "calculate_quote", note: "Obtain the server-authoritative price for the candidate booking." },
    { step: 4, tool: "create_booking_draft", note: "Create the draft order; receive order_id and a booking_access_token scoped to it." },
    { step: 5, tool: "get_booking_summary", note: "Read back the whitelisted summary and its current summary_hash for the customer to review." },
    { step: 6, tool: "update_booking_draft", note: "Optional — only if the customer needs to change something. Any successful update clears any prior confirmation.", optional: true },
    { step: 7, tool: "get_booking_summary", note: "If step 6 ran, re-display the summary so the customer confirms the CURRENT content, not a stale one.", conditional_on_step: 6 },
    { step: 8, tool: "confirm_booking_summary", note: "Record the customer's explicit agreement to the exact summary_hash they just saw." },
    { step: 9, tool: "create_payment_link", note: "Issue a one-time Stripe Checkout link for the confirmed, still-current summary." },
    { step: 10, tool: "get_payment_status", note: "Poll payment/inventory status after handing the customer the payment link." },
  ],
  caveats: [
    "Recommended vehicle capacity and reference prices from service-facts are references only, not a binding quote.",
    "The real, binding price is always computed server-side by calculate_quote / create_booking_draft, never supplied by the caller.",
    "No payment link may be created before the customer has explicitly confirmed the current booking summary via confirm_booking_summary.",
    "payment_status becoming \"paid\" is only ever true after Stripe's webhook has updated the database — no other signal indicates a successful payment.",
    "A generated payment page URL, or the customer following a browser redirect to it, does not by itself mean payment succeeded.",
    "Every booking, whether created by an Agent or the web form, is still manually re-reviewed by 华人Okinawa staff after submission.",
  ],
};

const tools = [
  {
    name: "check_availability",
    operation_id: "check_availability",
    method: "POST",
    path: "/api/agent/check-availability",
    purpose: "Check whether a car model and driver language are available for a given date range.",
    requires_agent_service_auth: true,
    requires_booking_access_token: false,
    requires_idempotency_key: false,
    allowed_stage: "pre_booking",
    next_tools: ["calculate_quote"],
    openapi_operation_ref: "#/paths/~1api~1agent~1check-availability/post",
  },
  {
    name: "calculate_quote",
    operation_id: "calculate_quote",
    method: "POST",
    path: "/api/agent/calculate-quote",
    purpose: "Compute the server-authoritative price, deposit, and balance for a candidate booking.",
    requires_agent_service_auth: true,
    requires_booking_access_token: false,
    requires_idempotency_key: false,
    allowed_stage: "pre_booking",
    next_tools: ["create_booking_draft"],
    openapi_operation_ref: "#/paths/~1api~1agent~1calculate-quote/post",
  },
  {
    name: "create_booking_draft",
    operation_id: "create_booking_draft",
    method: "POST",
    path: "/api/agent/create-booking-draft",
    purpose: "Create a new draft order and receive a booking_access_token scoped to it.",
    requires_agent_service_auth: true,
    requires_booking_access_token: false,
    requires_idempotency_key: true,
    allowed_stage: "draft_creation",
    next_tools: ["get_booking_summary"],
    openapi_operation_ref: "#/paths/~1api~1agent~1create-booking-draft/post",
  },
  {
    name: "get_booking_summary",
    operation_id: "get_booking_summary",
    method: "POST",
    path: "/api/agent/get-booking-summary",
    purpose: "Read the whitelisted, PII-free summary and current summary_hash for an existing order.",
    requires_agent_service_auth: true,
    requires_booking_access_token: true,
    requires_idempotency_key: false,
    allowed_stage: "draft_review",
    next_tools: ["update_booking_draft", "confirm_booking_summary"],
    openapi_operation_ref: "#/paths/~1api~1agent~1get-booking-summary/post",
  },
  {
    name: "update_booking_draft",
    operation_id: "update_booking_draft",
    method: "POST",
    path: "/api/agent/update-booking-draft",
    purpose: "Apply a partial change to a still-editable draft order. Any successful update clears any prior confirmation.",
    requires_agent_service_auth: true,
    requires_booking_access_token: true,
    requires_idempotency_key: false,
    allowed_stage: "draft_review",
    next_tools: ["get_booking_summary"],
    openapi_operation_ref: "#/paths/~1api~1agent~1update-booking-draft/post",
  },
  {
    name: "confirm_booking_summary",
    operation_id: "confirm_booking_summary",
    method: "POST",
    path: "/api/agent/confirm-booking-summary",
    purpose: "Record the customer's explicit confirmation of one specific, current summary_hash.",
    requires_agent_service_auth: true,
    requires_booking_access_token: true,
    requires_idempotency_key: false,
    allowed_stage: "confirmation",
    next_tools: ["create_payment_link"],
    openapi_operation_ref: "#/paths/~1api~1agent~1confirm-booking-summary/post",
  },
  {
    name: "create_payment_link",
    operation_id: "create_payment_link",
    method: "POST",
    path: "/api/agent/create-payment-link",
    purpose: "Issue a one-time Stripe Checkout payment link for an order whose current summary has been confirmed.",
    requires_agent_service_auth: true,
    requires_booking_access_token: true,
    requires_idempotency_key: false,
    allowed_stage: "payment",
    next_tools: ["get_payment_status"],
    openapi_operation_ref: "#/paths/~1api~1agent~1create-payment-link/post",
  },
  {
    name: "get_payment_status",
    operation_id: "get_payment_status",
    method: "POST",
    path: "/api/agent/get-payment-status",
    purpose: "Read the current payment and inventory status of an order.",
    requires_agent_service_auth: true,
    requires_booking_access_token: true,
    requires_idempotency_key: false,
    allowed_stage: "payment",
    next_tools: [],
    openapi_operation_ref: "#/paths/~1api~1agent~1get-payment-status/post",
  },
];

const agentCapabilities = deepFreeze({
  identity,
  discovery,
  access,
  auth_model,
  workflow,
  tools,
  service_facts_version: SERVICE_FACTS_VERSION,
});

module.exports = { AGENT_CAPABILITIES_VERSION, agentCapabilities };
