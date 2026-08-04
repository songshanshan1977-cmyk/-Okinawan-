// lib/public/openapiSpec.js
//
// OpenAPI 3.1 document describing every public discovery endpoint AND every
// existing Agent transactional tool endpoint. This is a DESCRIPTION of
// already-shipped behavior — schemas below are built from the real request
// validators (lib/agent/validation/validateBookingInput.js), the real
// vehicle/duration enums (lib/pricing/calcTotalPrice.js), the real error
// codes and their real HTTP statuses (lib/agent/errorCodes.js), and the
// real response shapes each lib/agent/tools/*.js function returns — never
// invented or guessed. Nothing here adds a new tool, changes an existing
// one, or grants any new access.
//
// Security requirement grouping (OpenAPI 3.1 semantics): every object
// inside a path's `security` array is one alternative (OR). This document
// therefore places every scheme a given tool genuinely requires ALL OF
// together, inside the SAME single object of that array (AND) — never as
// separate array entries, which would incorrectly mean "either one is
// enough". create_booking_draft needs AgentServiceBearer AND IdempotencyKey
// together in one object; the 5 order-scoped tools need AgentServiceBearer
// AND BookingAccessToken together in one object.

const { AGENT_ERROR_CODES, statusForCode } = require("../agent/errorCodes");
const { TEXT_MAX_LENGTHS } = require("../agent/validation/validateBookingInput");
const { VALID_CAR_MODEL_IDS, VALID_DURATIONS } = require("../pricing/calcTotalPrice");
const { SERVICE_FACTS_VERSION } = require("./serviceFacts");
const { AGENT_CAPABILITIES_VERSION } = require("./agentCapabilities");

const OPENAPI_SPEC_VERSION = "2026-08-02-v1";
const BASE_URL = "https://booking.xn--okinawa-n14kh45a.com";

const CAR_MODEL_IDS = Array.from(VALID_CAR_MODEL_IDS);
const DURATIONS = Array.from(VALID_DURATIONS);
const DRIVER_LANG_INPUTS = ["zh", "jp", "ZH", "JP"];

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
  }
  return value;
}

function okFalseSchema() {
  return { type: "boolean", enum: [false] };
}

function okTrueSchema() {
  return { type: "boolean", enum: [true] };
}

// Groups the given AGENT_ERROR_CODES values by their real HTTP status
// (lib/agent/errorCodes.js's own statusForCode) and returns one OpenAPI
// `responses` fragment per status, each with an `error` enum restricted to
// exactly the codes reachable at that status for this one operation.
function errorResponses(codes) {
  const byStatus = {};
  for (const code of codes) {
    const status = String(statusForCode(code));
    if (!byStatus[status]) byStatus[status] = [];
    if (!byStatus[status].includes(code)) byStatus[status].push(code);
  }

  const responses = {};
  for (const [status, list] of Object.entries(byStatus)) {
    responses[status] = {
      description: `Failure. \`error\` is one of: ${list.join(", ")}.`,
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["ok", "error"],
            properties: {
              ok: okFalseSchema(),
              error: { type: "string", enum: list },
            },
          },
        },
      },
    };
  }
  return responses;
}

// create_payment_link's 409 response has two real shapes, per
// pages/api/agent/create-payment-link.js: every 409 code returns
// {ok:false, error}, EXCEPT inventory_unavailable, which additionally
// carries unavailable_dates (read straight off createPaymentLinkTool's own
// result — see lib/agent/tools/createPaymentLink.js / lib/payment/
// createCheckoutSession.js). additionalProperties:false on the plain-error
// variant only reflects that specific set of codes never carrying anything
// else — inventory_unavailable is modeled as its own oneOf branch, so
// neither branch is a lossy approximation of the other. No internal
// unavailable_dates item field is invented — that shape has no stable
// public contract today.
function paymentLink409Response() {
  const plainCodes = [
    AGENT_ERROR_CODES.PAID_ORDER_IMMUTABLE,
    AGENT_ERROR_CODES.SUMMARY_NOT_CONFIRMED,
    AGENT_ERROR_CODES.PAYMENT_AUTHORIZATION_EXPIRED_OR_USED,
    AGENT_ERROR_CODES.PAYMENT_SUMMARY_STALE,
  ];

  return {
    description: `Failure. \`error\` is one of: ${plainCodes.join(", ")}, ${AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE}. When \`error\` is "${AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE}", the response additionally requires \`unavailable_dates\`.`,
    content: {
      "application/json": {
        schema: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["ok", "error"],
              properties: {
                ok: okFalseSchema(),
                error: { type: "string", enum: plainCodes },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["ok", "error", "unavailable_dates"],
              properties: {
                ok: okFalseSchema(),
                error: { type: "string", enum: [AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE] },
                unavailable_dates: { type: "array", items: { type: "object" } },
              },
            },
          ],
        },
      },
    },
  };
}

function successResponse(description, schema) {
  return {
    "200": {
      description,
      content: { "application/json": { schema } },
    },
  };
}

function requestBody(schema) {
  return {
    required: true,
    content: { "application/json": { schema } },
  };
}

// --- Shared field schemas, mirroring lib/agent/validation/validateBookingInput.js exactly ---

const carModelIdSchema = { type: "string", enum: CAR_MODEL_IDS, description: "One of the 3 real vehicle UUIDs." };
const driverLangSchema = { type: "string", enum: DRIVER_LANG_INPUTS, description: "Accepted raw casings only; normalized server-side to ZH/JP." };
const durationSchema = { type: "integer", enum: DURATIONS };
const dateSchema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Real calendar date, YYYY-MM-DD." };
const paxSchema = { type: "integer", minimum: 1 };
const luggageSchema = { type: "integer", minimum: 0 };
const nameSchema = { type: "string", minLength: 1, maxLength: TEXT_MAX_LENGTHS.name };
const phoneSchema = { type: "string", minLength: 1, maxLength: TEXT_MAX_LENGTHS.phone };
const emailSchema = { type: "string", format: "email", maxLength: TEXT_MAX_LENGTHS.email };
const departureHotelSchema = { type: "string", minLength: 1, maxLength: TEXT_MAX_LENGTHS.departure_hotel };
const endHotelSchema = { type: "string", minLength: 1, maxLength: TEXT_MAX_LENGTHS.end_hotel };
const wechatSchema = { type: "string", maxLength: TEXT_MAX_LENGTHS.wechat };
const itinerarySchema = { type: "string", maxLength: TEXT_MAX_LENGTHS.itinerary };
const remarkSchema = { type: "string", maxLength: TEXT_MAX_LENGTHS.remark };
const orderIdSchema = { type: "string", description: "Server-generated order identifier returned by create_booking_draft." };
const summaryHashSchema = { type: "string", description: "Opaque content hash returned alongside every booking summary." };
const currencySchema = { type: "string", enum: ["CNY"] };

// The full booking field set create_booking_draft requires — also the
// candidate-merge target for update_booking_draft's `changes` object,
// which accepts the same fields but all optional (partial update).
const DRAFT_FIELD_PROPERTIES = {
  car_model_id: carModelIdSchema,
  driver_lang: driverLangSchema,
  duration: durationSchema,
  start_date: dateSchema,
  end_date: dateSchema,
  pax: paxSchema,
  luggage: luggageSchema,
  departure_hotel: departureHotelSchema,
  end_hotel: endHotelSchema,
  name: nameSchema,
  phone: phoneSchema,
  email: emailSchema,
  wechat: wechatSchema,
  itinerary: itinerarySchema,
  remark: remarkSchema,
};

const DRAFT_REQUIRED_FIELDS = ["car_model_id", "driver_lang", "duration", "start_date", "end_date", "pax", "luggage", "departure_hotel", "end_hotel", "name", "phone", "email"];

// The exact safe-summary shape lib/agent/bookingSummary.js's toSafeSummary()
// returns — used verbatim by get_booking_summary, and as the shared base
// for update_booking_draft's response.
const SAFE_SUMMARY_PROPERTIES = {
  order_id: orderIdSchema,
  start_date: dateSchema,
  end_date: dateSchema,
  car_model_id: carModelIdSchema,
  driver_lang: { type: "string", enum: ["ZH", "JP"] },
  duration: durationSchema,
  pax: paxSchema,
  luggage: luggageSchema,
  departure_hotel: departureHotelSchema,
  end_hotel: endHotelSchema,
  total_price: { type: "number" },
  deposit_amount: { type: "number" },
  balance_due: { type: "number" },
  currency: currencySchema,
  payment_status: { type: "string" },
  inventory_status: { type: "string" },
  summary_hash: summaryHashSchema,
};
const SAFE_SUMMARY_REQUIRED = Object.keys(SAFE_SUMMARY_PROPERTIES);

// --- Paths ---

const publicGetResponses = (schemaRef) => ({
  "200": {
    description: "Public document.",
    content: { "application/json": { schema: { $ref: schemaRef } } },
  },
  "405": {
    description: "Method not allowed.",
    content: {
      "application/json": {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok", "error"],
          properties: { ok: okFalseSchema(), error: { type: "string", enum: ["method_not_allowed"] } },
        },
      },
    },
  },
});

const paths = {
  "/api/public/service-facts": {
    get: {
      operationId: "read_service_facts",
      summary: "Public, unauthenticated business facts (prices, capacity, contact, policy).",
      security: [],
      responses: publicGetResponses("#/components/schemas/ServiceFactsResponse"),
    },
  },
  "/api/public/agent-capabilities": {
    get: {
      operationId: "read_agent_capabilities",
      summary: "Public, unauthenticated Agent discovery document.",
      security: [],
      responses: publicGetResponses("#/components/schemas/AgentCapabilitiesResponse"),
    },
  },
  "/api/public/openapi": {
    get: {
      operationId: "read_openapi_document",
      summary: "This OpenAPI document itself.",
      security: [],
      responses: publicGetResponses("#/components/schemas/OpenApiDocumentResponse"),
    },
  },

  "/api/agent/check-availability": {
    post: {
      operationId: "check_availability",
      summary: "Check whether a car model and driver language are available for a date range.",
      security: [{ AgentServiceBearer: [] }],
      "x-huaren-okinawa-workflow": { step: 2, ref: "#/components/x-huaren-okinawa-workflow-ref" },
      requestBody: requestBody({
        type: "object",
        additionalProperties: false,
        required: ["car_model_id", "driver_lang", "start_date", "end_date"],
        properties: {
          car_model_id: carModelIdSchema,
          driver_lang: driverLangSchema,
          start_date: dateSchema,
          end_date: dateSchema,
        },
      }),
      responses: {
        ...successResponse("Availability result.", {
          type: "object",
          additionalProperties: false,
          required: ["ok", "available", "unavailable_dates", "min_remaining", "checked"],
          properties: {
            ok: okTrueSchema(),
            available: { type: "boolean" },
            unavailable_dates: { type: "array", items: { type: "object" } },
            min_remaining: { type: "number" },
            checked: { type: "object" },
          },
        }),
        ...errorResponses([AGENT_ERROR_CODES.AGENT_UNAUTHORIZED, AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED, AGENT_ERROR_CODES.INVALID_REQUEST, AGENT_ERROR_CODES.INVENTORY_CHECK_FAILED, AGENT_ERROR_CODES.INTERNAL_ERROR]),
      },
    },
  },

  "/api/agent/calculate-quote": {
    post: {
      operationId: "calculate_quote",
      summary: "Compute the server-authoritative price for a candidate booking.",
      security: [{ AgentServiceBearer: [] }],
      "x-huaren-okinawa-workflow": { step: 3, ref: "#/components/x-huaren-okinawa-workflow-ref" },
      requestBody: requestBody({
        type: "object",
        additionalProperties: false,
        required: ["car_model_id", "driver_lang", "duration", "start_date", "end_date"],
        properties: {
          car_model_id: carModelIdSchema,
          driver_lang: driverLangSchema,
          duration: durationSchema,
          start_date: dateSchema,
          end_date: dateSchema,
        },
      }),
      responses: {
        ...successResponse("Quote result.", {
          type: "object",
          additionalProperties: false,
          required: ["ok", "total_price", "deposit_amount", "balance_due", "currency", "days_count"],
          properties: {
            ok: okTrueSchema(),
            total_price: { type: "number" },
            deposit_amount: { type: "number" },
            balance_due: { type: "number" },
            currency: currencySchema,
            days_count: { type: "integer" },
          },
        }),
        ...errorResponses([AGENT_ERROR_CODES.AGENT_UNAUTHORIZED, AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED, AGENT_ERROR_CODES.INVALID_REQUEST, AGENT_ERROR_CODES.QUOTE_FAILED, AGENT_ERROR_CODES.INTERNAL_ERROR]),
      },
    },
  },

  "/api/agent/create-booking-draft": {
    post: {
      operationId: "create_booking_draft",
      summary: "Create a new draft order and receive a booking_access_token scoped to it.",
      security: [{ AgentServiceBearer: [], IdempotencyKey: [] }],
      "x-huaren-okinawa-workflow": { step: 4, ref: "#/components/x-huaren-okinawa-workflow-ref" },
      requestBody: requestBody({
        type: "object",
        additionalProperties: false,
        required: DRAFT_REQUIRED_FIELDS,
        properties: DRAFT_FIELD_PROPERTIES,
      }),
      responses: {
        ...successResponse("Draft created (or, for a replayed Idempotency-Key, the original draft returned again).", {
          type: "object",
          additionalProperties: false,
          required: ["ok", "order_id", "payment_status", "inventory_status", "total_price", "deposit_amount", "balance_due", "currency", "booking_access_token", "expires_at"],
          properties: {
            ok: okTrueSchema(),
            order_id: orderIdSchema,
            payment_status: { type: "string" },
            inventory_status: { type: "string" },
            total_price: { type: "number" },
            deposit_amount: { type: "number" },
            balance_due: { type: "number" },
            currency: currencySchema,
            booking_access_token: { type: "string", description: "Opaque, short-lived token. Example value is a placeholder only — never a real token." },
            expires_at: { type: "integer", description: "Unix epoch milliseconds." },
          },
        }),
        ...errorResponses([
          AGENT_ERROR_CODES.AGENT_UNAUTHORIZED,
          AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED,
          AGENT_ERROR_CODES.INVALID_REQUEST,
          AGENT_ERROR_CODES.QUOTE_FAILED,
          AGENT_ERROR_CODES.INVENTORY_CHECK_FAILED,
          AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE,
          AGENT_ERROR_CODES.DRAFT_CREATION_FAILED,
          AGENT_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          AGENT_ERROR_CODES.INTERNAL_ERROR,
        ]),
      },
    },
  },

  "/api/agent/get-booking-summary": {
    post: {
      operationId: "get_booking_summary",
      summary: "Read the whitelisted, PII-free summary and current summary_hash for an order.",
      security: [{ AgentServiceBearer: [], BookingAccessToken: [] }],
      "x-huaren-okinawa-workflow": { step: 5, ref: "#/components/x-huaren-okinawa-workflow-ref" },
      requestBody: requestBody({
        type: "object",
        additionalProperties: false,
        required: ["order_id"],
        properties: { order_id: orderIdSchema },
      }),
      responses: {
        ...successResponse("Booking summary.", {
          type: "object",
          additionalProperties: false,
          required: ["ok", ...SAFE_SUMMARY_REQUIRED],
          properties: { ok: okTrueSchema(), ...SAFE_SUMMARY_PROPERTIES },
        }),
        ...errorResponses([
          AGENT_ERROR_CODES.AGENT_UNAUTHORIZED,
          AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED,
          AGENT_ERROR_CODES.INVALID_REQUEST,
          AGENT_ERROR_CODES.BOOKING_ACCESS_INVALID,
          AGENT_ERROR_CODES.BOOKING_ACCESS_EXPIRED,
          AGENT_ERROR_CODES.BOOKING_ACCESS_ORDER_MISMATCH,
          AGENT_ERROR_CODES.ORDER_NOT_FOUND,
          AGENT_ERROR_CODES.INTERNAL_ERROR,
        ]),
      },
    },
  },

  "/api/agent/update-booking-draft": {
    post: {
      operationId: "update_booking_draft",
      summary: "Apply a partial change to a still-editable (draft) order; clears any prior confirmation.",
      security: [{ AgentServiceBearer: [], BookingAccessToken: [] }],
      "x-huaren-okinawa-workflow": { step: 6, optional: true, ref: "#/components/x-huaren-okinawa-workflow-ref" },
      requestBody: requestBody({
        type: "object",
        additionalProperties: false,
        required: ["order_id", "expected_summary_hash", "changes"],
        properties: {
          order_id: orderIdSchema,
          expected_summary_hash: summaryHashSchema,
          changes: {
            type: "object",
            additionalProperties: false,
            minProperties: 1,
            properties: DRAFT_FIELD_PROPERTIES,
            description: "Partial update. Only these fields may be present; any other key is rejected.",
          },
        },
      }),
      responses: {
        ...successResponse("Draft updated; a fresh summary_hash is returned and must be re-confirmed.", {
          type: "object",
          additionalProperties: false,
          required: ["ok", "updated", "confirmed", ...SAFE_SUMMARY_REQUIRED],
          properties: {
            ok: okTrueSchema(),
            updated: { type: "boolean", enum: [true] },
            confirmed: { type: "boolean", enum: [false] },
            ...SAFE_SUMMARY_PROPERTIES,
          },
        }),
        ...errorResponses([
          AGENT_ERROR_CODES.AGENT_UNAUTHORIZED,
          AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED,
          AGENT_ERROR_CODES.INVALID_REQUEST,
          AGENT_ERROR_CODES.BOOKING_ACCESS_INVALID,
          AGENT_ERROR_CODES.BOOKING_ACCESS_EXPIRED,
          AGENT_ERROR_CODES.BOOKING_ACCESS_ORDER_MISMATCH,
          AGENT_ERROR_CODES.ORDER_NOT_FOUND,
          AGENT_ERROR_CODES.PAID_ORDER_IMMUTABLE,
          AGENT_ERROR_CODES.SUMMARY_STALE,
          AGENT_ERROR_CODES.QUOTE_FAILED,
          AGENT_ERROR_CODES.INVENTORY_CHECK_FAILED,
          AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE,
          AGENT_ERROR_CODES.UPDATE_FAILED,
          AGENT_ERROR_CODES.INTERNAL_ERROR,
        ]),
      },
    },
  },

  "/api/agent/confirm-booking-summary": {
    post: {
      operationId: "confirm_booking_summary",
      summary: "Record the customer's explicit confirmation of one specific, current summary_hash.",
      security: [{ AgentServiceBearer: [], BookingAccessToken: [] }],
      "x-huaren-okinawa-workflow": { step: 8, ref: "#/components/x-huaren-okinawa-workflow-ref" },
      requestBody: requestBody({
        type: "object",
        additionalProperties: false,
        required: ["order_id", "summary_hash"],
        properties: { order_id: orderIdSchema, summary_hash: summaryHashSchema },
      }),
      responses: {
        ...successResponse("Confirmation recorded (or an identical prior confirmation replayed unchanged).", {
          type: "object",
          additionalProperties: false,
          required: ["ok", "confirmed", "order_id", "summary_hash", "confirmed_at"],
          properties: {
            ok: okTrueSchema(),
            confirmed: { type: "boolean", enum: [true] },
            order_id: orderIdSchema,
            summary_hash: summaryHashSchema,
            confirmed_at: { type: "string", format: "date-time" },
          },
        }),
        ...errorResponses([
          AGENT_ERROR_CODES.AGENT_UNAUTHORIZED,
          AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED,
          AGENT_ERROR_CODES.INVALID_REQUEST,
          AGENT_ERROR_CODES.BOOKING_ACCESS_INVALID,
          AGENT_ERROR_CODES.BOOKING_ACCESS_EXPIRED,
          AGENT_ERROR_CODES.BOOKING_ACCESS_ORDER_MISMATCH,
          AGENT_ERROR_CODES.ORDER_NOT_FOUND,
          AGENT_ERROR_CODES.PAID_ORDER_IMMUTABLE,
          AGENT_ERROR_CODES.SUMMARY_STALE,
          AGENT_ERROR_CODES.CONFIRMATION_FAILED,
          AGENT_ERROR_CODES.INTERNAL_ERROR,
        ]),
      },
    },
  },

  "/api/agent/create-payment-link": {
    post: {
      operationId: "create_payment_link",
      summary: "Issue a one-time Stripe Checkout payment link for an order whose current summary is confirmed.",
      security: [{ AgentServiceBearer: [], BookingAccessToken: [] }],
      "x-huaren-okinawa-workflow": { step: 9, ref: "#/components/x-huaren-okinawa-workflow-ref" },
      requestBody: requestBody({
        type: "object",
        additionalProperties: false,
        required: ["order_id"],
        properties: { order_id: orderIdSchema },
      }),
      responses: {
        ...successResponse("Payment link created.", {
          type: "object",
          additionalProperties: false,
          required: ["ok", "order_id", "payment_status", "url", "expires_at"],
          properties: {
            ok: okTrueSchema(),
            order_id: orderIdSchema,
            payment_status: { type: "string", enum: ["pending"] },
            url: { type: "string", format: "uri", description: "Example value is a placeholder only — never a real Checkout URL." },
            expires_at: { type: "string", format: "date-time" },
          },
        }),
        ...errorResponses([
          AGENT_ERROR_CODES.AGENT_UNAUTHORIZED,
          AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED,
          AGENT_ERROR_CODES.INVALID_REQUEST,
          AGENT_ERROR_CODES.BOOKING_ACCESS_INVALID,
          AGENT_ERROR_CODES.BOOKING_ACCESS_EXPIRED,
          AGENT_ERROR_CODES.BOOKING_ACCESS_ORDER_MISMATCH,
          AGENT_ERROR_CODES.ORDER_NOT_FOUND,
          AGENT_ERROR_CODES.PAYMENT_AUTHORIZATION_FAILED,
          AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED,
          AGENT_ERROR_CODES.PAYMENT_SESSION_WRITE_FAILED,
          AGENT_ERROR_CODES.INTERNAL_ERROR,
        ]),
        // The 4 other 409 codes plus inventory_unavailable (which alone
        // additionally carries unavailable_dates) are handled together here
        // instead of via errorResponses(), since they share one HTTP status
        // but not one response shape — see paymentLink409Response().
        "409": paymentLink409Response(),
      },
    },
  },

  "/api/agent/get-payment-status": {
    post: {
      operationId: "get_payment_status",
      summary: "Read the current payment and inventory status of an order.",
      security: [{ AgentServiceBearer: [], BookingAccessToken: [] }],
      "x-huaren-okinawa-workflow": { step: 10, ref: "#/components/x-huaren-okinawa-workflow-ref" },
      requestBody: requestBody({
        type: "object",
        additionalProperties: false,
        required: ["order_id"],
        properties: { order_id: orderIdSchema },
      }),
      responses: {
        ...successResponse("Payment/inventory status.", {
          type: "object",
          additionalProperties: false,
          required: ["ok", "order_id", "payment_status", "inventory_status", "inventory_locked", "paid"],
          properties: {
            ok: okTrueSchema(),
            order_id: orderIdSchema,
            payment_status: { type: "string" },
            inventory_status: { type: "string" },
            inventory_locked: { type: "boolean" },
            paid: { type: "boolean" },
          },
        }),
        ...errorResponses([
          AGENT_ERROR_CODES.AGENT_UNAUTHORIZED,
          AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED,
          AGENT_ERROR_CODES.INVALID_REQUEST,
          AGENT_ERROR_CODES.BOOKING_ACCESS_INVALID,
          AGENT_ERROR_CODES.BOOKING_ACCESS_EXPIRED,
          AGENT_ERROR_CODES.BOOKING_ACCESS_ORDER_MISMATCH,
          AGENT_ERROR_CODES.ORDER_NOT_FOUND,
          AGENT_ERROR_CODES.INTERNAL_ERROR,
        ]),
      },
    },
  },
};

const openapiSpec = deepFreeze({
  openapi: "3.1.0",
  info: {
    title: "华人Okinawa Agent Booking API",
    version: OPENAPI_SPEC_VERSION,
    description: "Public discovery + Agent transactional tool surface for 华人Okinawa's Okinawa car-charter booking system. See /api/public/agent-capabilities for the human/Agent-readable workflow narrative this document's x-huaren-okinawa-workflow extension refers to.",
  },
  servers: [{ url: BASE_URL }],
  "x-huaren-okinawa-workflow-ref": `${BASE_URL}/api/public/agent-capabilities`,
  "x-huaren-okinawa-service-facts-version": SERVICE_FACTS_VERSION,
  "x-huaren-okinawa-capabilities-version": AGENT_CAPABILITIES_VERSION,
  paths,
  components: {
    securitySchemes: {
      AgentServiceBearer: { type: "http", scheme: "bearer" },
      BookingAccessToken: { type: "apiKey", in: "header", name: "X-Booking-Access-Token" },
      IdempotencyKey: { type: "apiKey", in: "header", name: "Idempotency-Key" },
    },
    schemas: {
      ServiceFactsResponse: { type: "object" },
      AgentCapabilitiesResponse: { type: "object" },
      OpenApiDocumentResponse: { type: "object" },
    },
  },
});

module.exports = { OPENAPI_SPEC_VERSION, openapiSpec };
