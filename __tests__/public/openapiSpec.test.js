const { OPENAPI_SPEC_VERSION, openapiSpec } = require("../../lib/public/openapiSpec");
const { AGENT_CAPABILITIES_VERSION, agentCapabilities } = require("../../lib/public/agentCapabilities");
const { SERVICE_FACTS_VERSION } = require("../../lib/public/serviceFacts");

const TOOL_NAMES = [
  "check_availability",
  "calculate_quote",
  "create_booking_draft",
  "get_booking_summary",
  "update_booking_draft",
  "confirm_booking_summary",
  "create_payment_link",
  "get_payment_status",
];

const AGENT_PATHS = {
  check_availability: "/api/agent/check-availability",
  calculate_quote: "/api/agent/calculate-quote",
  create_booking_draft: "/api/agent/create-booking-draft",
  get_booking_summary: "/api/agent/get-booking-summary",
  update_booking_draft: "/api/agent/update-booking-draft",
  confirm_booking_summary: "/api/agent/confirm-booking-summary",
  create_payment_link: "/api/agent/create-payment-link",
  get_payment_status: "/api/agent/get-payment-status",
};

const FORBIDDEN_STRINGS = ["songshanshan1977@gmail.com", "songshanshan2025@gmail.com", "contact@okinawa-charter.com"];

// The 5 real Secret env-var names — must never appear as literal substrings
// in the fully serialized document (a name appearing would suggest the
// value could have been interpolated in by mistake).
const SECRET_ENV_VAR_NAMES = ["AGENT_SERVICE_KEY", "AGENT_BOOKING_TOKEN_SECRET", "SUPABASE_SERVICE_ROLE_KEY", "STRIPE_SECRET_KEY", "RESEND_API_KEY"];

function agentToolOperations() {
  const ops = {};
  for (const [path, item] of Object.entries(openapiSpec.paths)) {
    if (item.post && TOOL_NAMES.includes(item.post.operationId)) {
      ops[item.post.operationId] = { path, operation: item.post };
    }
  }
  return ops;
}

describe("openapiSpec — module shape", () => {
  test("is a plain frozen object", () => {
    expect(Object.isFrozen(openapiSpec)).toBe(true);
    expect(Object.isFrozen(openapiSpec.paths)).toBe(true);
    expect(() => {
      openapiSpec.info.title = "tampered";
    }).toThrow(TypeError);
    expect(openapiSpec.info.title).toBe("华人Okinawa Agent Booking API");
  });

  test("basic info block matches spec: openapi 3.1.0, title, version, single server", () => {
    expect(openapiSpec.openapi).toBe("3.1.0");
    expect(openapiSpec.info.title).toBe("华人Okinawa Agent Booking API");
    expect(openapiSpec.info.version).toBe("2026-08-02-v1");
    expect(OPENAPI_SPEC_VERSION).toBe("2026-08-02-v1");
    expect(openapiSpec.servers).toEqual([{ url: "https://booking.xn--okinawa-n14kh45a.com" }]);
  });

  test("references the real, current service_facts_version and capabilities version", () => {
    expect(openapiSpec["x-huaren-okinawa-service-facts-version"]).toBe(SERVICE_FACTS_VERSION);
    expect(openapiSpec["x-huaren-okinawa-capabilities-version"]).toBe(AGENT_CAPABILITIES_VERSION);
  });
});

describe("openapiSpec — security schemes", () => {
  test("declares exactly the 3 named schemes with the correct shapes", () => {
    const schemes = openapiSpec.components.securitySchemes;
    expect(Object.keys(schemes).sort()).toEqual(["AgentServiceBearer", "BookingAccessToken", "IdempotencyKey"].sort());
    expect(schemes.AgentServiceBearer).toEqual({ type: "http", scheme: "bearer" });
    expect(schemes.BookingAccessToken).toEqual({ type: "apiKey", in: "header", name: "X-Booking-Access-Token" });
    expect(schemes.IdempotencyKey).toEqual({ type: "apiKey", in: "header", name: "Idempotency-Key" });
  });
});

describe("openapiSpec — public paths", () => {
  test("has exactly the 3 public GET paths with security: []", () => {
    for (const path of ["/api/public/service-facts", "/api/public/agent-capabilities", "/api/public/openapi"]) {
      expect(openapiSpec.paths).toHaveProperty(path);
      expect(openapiSpec.paths[path].get.security).toEqual([]);
    }
  });
});

describe("openapiSpec — transactional paths", () => {
  const ops = agentToolOperations();

  test("has exactly 8 agent tool operations, operationId strictly equals the 8 real tool names", () => {
    expect(Object.keys(ops).sort()).toEqual([...TOOL_NAMES].sort());
  });

  test("does not define a recommend_vehicle or any other invented operation", () => {
    const allOperationIds = Object.values(openapiSpec.paths)
      .flatMap((item) => [item.get, item.post])
      .filter(Boolean)
      .map((op) => op.operationId);
    expect(allOperationIds).not.toContain("recommend_vehicle");
    // Every non-public operationId must be one of the 8 real tools.
    const nonPublic = allOperationIds.filter((id) => !["read_service_facts", "read_agent_capabilities", "read_openapi_document"].includes(id));
    expect(nonPublic.sort()).toEqual([...TOOL_NAMES].sort());
  });

  test("each tool is defined under POST (not GET) at the real endpoint path", () => {
    for (const name of TOOL_NAMES) {
      const pathItem = openapiSpec.paths[AGENT_PATHS[name]];
      expect(pathItem.post.operationId).toBe(name);
      expect(pathItem.get).toBeUndefined();
      expect(ops[name].path).toBe(AGENT_PATHS[name]);
    }
  });

  test("check_availability and calculate_quote require ONLY AgentServiceBearer (single combined requirement)", () => {
    for (const name of ["check_availability", "calculate_quote"]) {
      expect(ops[name].operation.security).toEqual([{ AgentServiceBearer: [] }]);
    }
  });

  test("create_booking_draft requires AgentServiceBearer AND IdempotencyKey together in ONE requirement object (AND, not two alternatives)", () => {
    const security = ops.create_booking_draft.operation.security;
    expect(security).toHaveLength(1);
    expect(security[0]).toEqual({ AgentServiceBearer: [], IdempotencyKey: [] });
  });

  test("the 5 order-scoped tools require AgentServiceBearer AND BookingAccessToken together in ONE requirement object", () => {
    const orderScoped = ["get_booking_summary", "update_booking_draft", "confirm_booking_summary", "create_payment_link", "get_payment_status"];
    for (const name of orderScoped) {
      const security = ops[name].operation.security;
      expect(security).toHaveLength(1);
      expect(security[0]).toEqual({ AgentServiceBearer: [], BookingAccessToken: [] });
    }
  });

  test("every transactional request body schema uses additionalProperties: false", () => {
    for (const name of TOOL_NAMES) {
      const schema = ops[name].operation.requestBody.content["application/json"].schema;
      expect(schema.additionalProperties).toBe(false);
    }
  });

  test("create_booking_draft schema rejects existing_order_id/order_id (not in properties, and additionalProperties is false)", () => {
    const schema = ops.create_booking_draft.operation.requestBody.content["application/json"].schema;
    expect(schema.properties).not.toHaveProperty("existing_order_id");
    expect(schema.properties).not.toHaveProperty("order_id");
    expect(schema.additionalProperties).toBe(false);
  });

  test("create_booking_draft required fields match validateDraftInput's mandatory set", () => {
    const schema = ops.create_booking_draft.operation.requestBody.content["application/json"].schema;
    expect([...schema.required].sort()).toEqual(
      ["car_model_id", "driver_lang", "duration", "start_date", "end_date", "pax", "luggage", "departure_hotel", "end_hotel", "name", "phone", "email"].sort()
    );
    // wechat/itinerary/remark are optional
    expect(schema.required).not.toContain("wechat");
    expect(schema.required).not.toContain("itinerary");
    expect(schema.required).not.toContain("remark");
  });

  test("car_model_id enum has exactly the 3 real vehicle UUIDs, duration enum is exactly [8,10]", () => {
    const schema = ops.check_availability.operation.requestBody.content["application/json"].schema;
    expect(schema.properties.car_model_id.enum).toHaveLength(3);
    const quoteSchema = ops.calculate_quote.operation.requestBody.content["application/json"].schema;
    expect([...quoteSchema.properties.duration.enum].sort((a, b) => a - b)).toEqual([8, 10]);
  });

  test("booking_access_token only appears in create_booking_draft's success response schema", () => {
    for (const name of TOOL_NAMES) {
      const successSchema = ops[name].operation.responses["200"].content["application/json"].schema;
      const props = Object.keys(successSchema.properties || {});
      if (name === "create_booking_draft") {
        expect(props).toContain("booking_access_token");
      } else {
        expect(props).not.toContain("booking_access_token");
      }
    }
  });

  test("no response schema exposes a summary_hash from create_payment_link or get_payment_status", () => {
    for (const name of ["create_payment_link", "get_payment_status"]) {
      const successSchema = ops[name].operation.responses["200"].content["application/json"].schema;
      expect(Object.keys(successSchema.properties)).not.toContain("summary_hash");
      expect(Object.keys(successSchema.properties)).not.toContain("stripe_session_id");
    }
  });

  test("error responses use only real AGENT_ERROR_CODES string values", () => {
    const { AGENT_ERROR_CODES } = require("../../lib/agent/errorCodes");
    const validCodes = new Set(Object.values(AGENT_ERROR_CODES));
    for (const name of TOOL_NAMES) {
      const responses = ops[name].operation.responses;
      for (const [status, resp] of Object.entries(responses)) {
        if (status === "200") continue;
        const enumValues = resp.content["application/json"].schema.properties.error.enum;
        for (const code of enumValues) {
          expect(validCodes.has(code)).toBe(true);
        }
      }
    }
  });

  test("every x-huaren-okinawa-workflow step reference matches a real step number in agentCapabilities.workflow.steps", () => {
    const stepNumbers = new Set(agentCapabilities.workflow.steps.map((s) => s.step));
    for (const name of TOOL_NAMES) {
      const ext = ops[name].operation["x-huaren-okinawa-workflow"];
      expect(ext).toBeDefined();
      expect(stepNumbers.has(ext.step)).toBe(true);
    }
  });
});

describe("openapiSpec <-> agentCapabilities cross-document consistency", () => {
  test("the 8 tools listed in Capabilities are exactly the 8 operationIds in OpenAPI", () => {
    const capTools = agentCapabilities.tools.map((t) => t.name).sort();
    const ops = agentToolOperations();
    expect(Object.keys(ops).sort()).toEqual(capTools);
  });

  test("method and path per tool match between the two documents", () => {
    const ops = agentToolOperations();
    for (const tool of agentCapabilities.tools) {
      expect(ops[tool.name]).toBeDefined();
      expect(tool.method).toBe("POST");
      expect(ops[tool.name].path).toBe(tool.path);
    }
  });

  test("security requirements in OpenAPI match the auth flags declared in Capabilities", () => {
    const ops = agentToolOperations();
    for (const tool of agentCapabilities.tools) {
      const security = ops[tool.name].operation.security;
      expect(security).toHaveLength(1);
      const scheme = security[0];

      expect(tool.requires_agent_service_auth).toBe(true);
      expect(scheme).toHaveProperty("AgentServiceBearer");

      if (tool.requires_booking_access_token) {
        expect(scheme).toHaveProperty("BookingAccessToken");
      } else {
        expect(scheme).not.toHaveProperty("BookingAccessToken");
      }

      if (tool.requires_idempotency_key) {
        expect(scheme).toHaveProperty("IdempotencyKey");
      } else {
        expect(scheme).not.toHaveProperty("IdempotencyKey");
      }
    }
  });

  test("both documents reference the identical, real service_facts_version", () => {
    expect(agentCapabilities.service_facts_version).toBe(SERVICE_FACTS_VERSION);
    expect(openapiSpec["x-huaren-okinawa-service-facts-version"]).toBe(SERVICE_FACTS_VERSION);
    expect(agentCapabilities.service_facts_version).toBe(openapiSpec["x-huaren-okinawa-service-facts-version"]);
  });

  test("openapi_operation_ref in each Capabilities tool resolves to that tool's real path+POST in OpenAPI", () => {
    for (const tool of agentCapabilities.tools) {
      const escapedPath = tool.path.replace(/~/g, "~0").replace(/\//g, "~1");
      expect(tool.openapi_operation_ref).toBe(`#/paths/${escapedPath}/post`);
    }
  });
});

describe("openapiSpec — forbidden strings never appear anywhere in the full serialized document", () => {
  const serialized = JSON.stringify(openapiSpec);
  const retiredTestBrandName = "Honest" + "Oki";

  for (const forbidden of FORBIDDEN_STRINGS) {
    test(`does not contain "${forbidden}"`, () => {
      expect(serialized).not.toContain(forbidden);
    });
  }

  test("does not contain the retired test brand name", () => {
    expect(serialized).not.toContain(retiredTestBrandName);
    expect(serialized.toLowerCase()).not.toContain(retiredTestBrandName.toLowerCase());
  });

  for (const envVarName of SECRET_ENV_VAR_NAMES) {
    test(`does not contain the secret env-var name "${envVarName}"`, () => {
      expect(serialized).not.toContain(envVarName);
    });
  }

  test("does not contain a realistic-looking Bearer/token example or a Stripe/Resend-shaped secret", () => {
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{20,}/);
    expect(serialized).not.toMatch(/sk_live_|sk_test_|re_[A-Za-z0-9]{16,}/);
  });

  test("does not contain the historical LINE ID", () => {
    expect(serialized).not.toMatch(/okinawacharter/i);
  });
});
