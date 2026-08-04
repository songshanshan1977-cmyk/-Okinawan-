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
        const schema = resp.content["application/json"].schema;
        // Most error responses are a single flat {ok,error} schema, but a
        // status can also be modeled as oneOf several shapes (see
        // create_payment_link's 409 — paymentLink409Response()) — check
        // every branch's error enum in that case.
        const branches = schema.oneOf || [schema];
        for (const branch of branches) {
          for (const code of branch.properties.error.enum) {
            expect(validCodes.has(code)).toBe(true);
          }
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

// Minimal, purpose-built validator for the flat/oneOf {ok,error[,...]}
// object schemas this spec actually uses — not a general JSON Schema
// engine, just enough to prove real API response payloads validate (or
// don't) against paymentLink409Response()'s two branches the same way a
// real OpenAPI/JSON-Schema validator would.
function matchesObjectSchema(schema, value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const props = schema.properties || {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in props)) return false;
    }
  }
  for (const req of schema.required || []) {
    if (!(req in value)) return false;
  }
  for (const [key, val] of Object.entries(value)) {
    const propSchema = props[key];
    if (!propSchema) continue;
    if (propSchema.enum && !propSchema.enum.includes(val)) return false;
    if (propSchema.type === "boolean" && typeof val !== "boolean") return false;
    if (propSchema.type === "string" && typeof val !== "string") return false;
    if (propSchema.type === "array" && !Array.isArray(val)) return false;
  }
  return true;
}

function countOneOfMatches(schema, value) {
  const branches = schema.oneOf || [schema];
  return branches.filter((branch) => matchesObjectSchema(branch, value)).length;
}

describe("create_payment_link 409 — real inventory_unavailable payload vs. real plain-error payload", () => {
  const ops = agentToolOperations();
  const schema409 = ops.create_payment_link.operation.responses["409"].content["application/json"].schema;

  test("the 409 schema is modeled as oneOf two branches (plain-error vs. inventory_unavailable+unavailable_dates)", () => {
    expect(Array.isArray(schema409.oneOf)).toBe(true);
    expect(schema409.oneOf).toHaveLength(2);
  });

  test("a real inventory_unavailable response — exactly what pages/api/agent/create-payment-link.js sends — validates against exactly one branch", () => {
    // Mirrors pages/api/agent/create-payment-link.js:52-58 exactly: on
    // AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE the handler adds
    // unavailable_dates straight off the tool result.
    const realPayload = { ok: false, error: "inventory_unavailable", unavailable_dates: [] };
    expect(countOneOfMatches(schema409, realPayload)).toBe(1);

    const realPayloadWithDates = { ok: false, error: "inventory_unavailable", unavailable_dates: [{ date: "2026-09-01" }] };
    expect(countOneOfMatches(schema409, realPayloadWithDates)).toBe(1);
  });

  test("additionalProperties:false does NOT wrongly reject the real inventory_unavailable response for carrying unavailable_dates", () => {
    const realPayload = { ok: false, error: "inventory_unavailable", unavailable_dates: [] };
    // The inventory_unavailable branch specifically must accept it.
    const inventoryBranch = schema409.oneOf.find((b) => b.properties.error.enum.includes("inventory_unavailable"));
    expect(matchesObjectSchema(inventoryBranch, realPayload)).toBe(true);
  });

  test("unavailable_dates is REQUIRED (not merely allowed) on the inventory_unavailable branch, and its items are un-invented generic objects", () => {
    const inventoryBranch = schema409.oneOf.find((b) => b.properties.error.enum.includes("inventory_unavailable"));
    expect(inventoryBranch.required).toContain("unavailable_dates");
    expect(inventoryBranch.properties.unavailable_dates).toEqual({ type: "array", items: { type: "object" } });
  });

  test("the inventory_unavailable branch's error enum contains ONLY inventory_unavailable (not the other 4 codes)", () => {
    const inventoryBranch = schema409.oneOf.find((b) => b.properties.error.enum.includes("inventory_unavailable"));
    expect(inventoryBranch.properties.error.enum).toEqual(["inventory_unavailable"]);
  });

  test.each(["paid_order_immutable", "summary_not_confirmed", "payment_authorization_expired_or_used", "payment_summary_stale"])(
    "a plain 409 error (%s) — {ok,error} only, no unavailable_dates — still validates against exactly one branch",
    (code) => {
      const realPayload = { ok: false, error: code };
      expect(countOneOfMatches(schema409, realPayload)).toBe(1);
    }
  );

  test("a plain 409 code carrying unavailable_dates (a combination the real API never produces) matches neither branch", () => {
    const wronglyShapedPayload = { ok: false, error: "paid_order_immutable", unavailable_dates: [] };
    // Rejected by the plain branch (additionalProperties:false, unavailable_dates
    // not in its properties) AND by the inventory_unavailable branch (error
    // enum mismatch) — correctly invalid under oneOf.
    expect(countOneOfMatches(schema409, wronglyShapedPayload)).toBe(0);
  });

  test("the plain branch alone (ignoring inventory_unavailable) is unaffected: still {ok,error} only, additionalProperties:false", () => {
    const plainBranch = schema409.oneOf.find((b) => !b.properties.error.enum.includes("inventory_unavailable"));
    expect(plainBranch.additionalProperties).toBe(false);
    expect(Object.keys(plainBranch.properties).sort()).toEqual(["error", "ok"]);
    expect([...plainBranch.required].sort()).toEqual(["error", "ok"]);
  });
});

describe("openapiSpec — the create_payment_link contract fix does not change the other 7 tools", () => {
  const ops = agentToolOperations();
  const OTHER_TOOLS = TOOL_NAMES.filter((name) => name !== "create_payment_link");

  test("no other tool's 409 (or any other status) response schema uses oneOf", () => {
    for (const name of OTHER_TOOLS) {
      for (const [status, resp] of Object.entries(ops[name].operation.responses)) {
        if (status === "200") continue;
        expect(resp.content["application/json"].schema.oneOf).toBeUndefined();
      }
    }
  });

  test("no other tool's ERROR response gained an unavailable_dates field (check_availability's own 200 success response already legitimately has one, unrelated to this fix)", () => {
    for (const name of OTHER_TOOLS) {
      for (const [status, resp] of Object.entries(ops[name].operation.responses)) {
        if (status === "200") continue;
        const schema = resp.content["application/json"].schema;
        expect(Object.keys(schema.properties || {})).not.toContain("unavailable_dates");
      }
    }
  });

  test("create_payment_link's non-409 statuses (200/401/400/404/500) are unchanged: flat {ok,error} shape, no oneOf", () => {
    const responses = ops.create_payment_link.operation.responses;
    for (const status of ["401", "400", "404", "500"]) {
      const schema = responses[status].content["application/json"].schema;
      expect(schema.oneOf).toBeUndefined();
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties).sort()).toEqual(["error", "ok"]);
    }
  });

  test("Capabilities <-> OpenAPI 8-tool consistency still holds after the fix", () => {
    const capTools = agentCapabilities.tools.map((t) => t.name).sort();
    expect(Object.keys(ops).sort()).toEqual(capTools);
    expect(capTools).toHaveLength(8);
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
