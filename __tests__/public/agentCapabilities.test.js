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

const FORBIDDEN_STRINGS = ["songshanshan1977@gmail.com", "songshanshan2025@gmail.com", "contact@okinawa-charter.com"];

describe("agentCapabilities — module shape", () => {
  test("is a plain frozen object, safe against accidental mutation", () => {
    expect(Object.isFrozen(agentCapabilities)).toBe(true);
    expect(Object.isFrozen(agentCapabilities.tools)).toBe(true);
    expect(Object.isFrozen(agentCapabilities.tools[0])).toBe(true);
    expect(Object.isFrozen(agentCapabilities.workflow.steps)).toBe(true);
    expect(() => {
      agentCapabilities.identity.brand = "tampered";
    }).toThrow(TypeError);
    expect(agentCapabilities.identity.brand).toBe("华人Okinawa");
  });

  test("version constant matches this round's value", () => {
    expect(AGENT_CAPABILITIES_VERSION).toBe("2026-08-02-v1");
  });

  test("has exactly these 7 top-level fields", () => {
    expect(Object.keys(agentCapabilities).sort()).toEqual(["access", "auth_model", "discovery", "identity", "service_facts_version", "tools", "workflow"].sort());
  });

  test("references the real, current service_facts_version", () => {
    expect(agentCapabilities.service_facts_version).toBe(SERVICE_FACTS_VERSION);
  });
});

describe("agentCapabilities — identity / discovery / access", () => {
  test("identity names the brand, service area, and service-facts URL", () => {
    expect(agentCapabilities.identity.brand).toBe("华人Okinawa");
    expect(agentCapabilities.identity.service_area).toBe("Okinawa, Japan");
    expect(agentCapabilities.identity.service_facts_url).toBe("https://booking.xn--okinawa-n14kh45a.com/api/public/service-facts");
  });

  test("discovery URLs point at the capabilities and openapi endpoints under the same host", () => {
    expect(agentCapabilities.discovery.capabilities_url).toBe("https://booking.xn--okinawa-n14kh45a.com/api/public/agent-capabilities");
    expect(agentCapabilities.discovery.openapi_url).toBe("https://booking.xn--okinawa-n14kh45a.com/api/public/openapi");
  });

  test("access declares public info unauthenticated, transaction tools partner-authorized, no self-service registration", () => {
    expect(agentCapabilities.access.public_information).toBe("unauthenticated");
    expect(agentCapabilities.access.transaction_tools).toBe("partner_authorization_required");
    expect(agentCapabilities.access.self_service_registration).toBe(false);
    expect(agentCapabilities.access.access_contact).toBe("huarenokinawa2025@gmail.com");
  });

  test("access notes state that an unknown Agent cannot guess/obtain the service key", () => {
    const text = agentCapabilities.access.notes.join(" ");
    expect(text).toMatch(/cannot guess, derive, or self-issue/i);
    expect(text).toMatch(/no self-service signup or key-generation endpoint/i);
  });
});

describe("agentCapabilities — auth_model", () => {
  test("describes exactly the three named auth concepts, with header names, no real values", () => {
    expect(Object.keys(agentCapabilities.auth_model).sort()).toEqual(["AgentServiceBearer", "BookingAccessToken", "Idempotency-Key"].sort());
    expect(agentCapabilities.auth_model.AgentServiceBearer.header).toBe("Authorization: Bearer <partner credential>");
    expect(agentCapabilities.auth_model.BookingAccessToken.header).toBe("X-Booking-Access-Token");
    expect(agentCapabilities.auth_model["Idempotency-Key"].header).toBe("Idempotency-Key");
  });
});

describe("agentCapabilities — workflow", () => {
  test("has exactly 10 fixed steps in the documented order", () => {
    const steps = agentCapabilities.workflow.steps;
    expect(steps).toHaveLength(10);
    expect(steps.map((s) => s.tool)).toEqual([
      "read_service_facts",
      "check_availability",
      "calculate_quote",
      "create_booking_draft",
      "get_booking_summary",
      "update_booking_draft",
      "get_booking_summary",
      "confirm_booking_summary",
      "create_payment_link",
      "get_payment_status",
    ]);
  });

  test("step numbers run 1..10 in order", () => {
    expect(agentCapabilities.workflow.steps.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("update_booking_draft (step 6) is marked optional", () => {
    expect(agentCapabilities.workflow.steps[5].tool).toBe("update_booking_draft");
    expect(agentCapabilities.workflow.steps[5].optional).toBe(true);
  });

  test("caveats cover reference-only prices, server-side quoting, confirm-before-pay, webhook-only paid, redirect != success, manual review", () => {
    const text = agentCapabilities.workflow.caveats.join(" ");
    expect(text).toMatch(/references only/i);
    expect(text).toMatch(/computed server-side/i);
    expect(text).toMatch(/confirmed the current booking summary/i);
    expect(text).toMatch(/Stripe's webhook/i);
    expect(text).toMatch(/does not by itself mean payment succeeded/i);
    expect(text).toMatch(/manually re-reviewed/i);
  });
});

describe("agentCapabilities — tools", () => {
  test("exposes exactly the 8 real tools, no more, no fewer, no invented tool", () => {
    expect(agentCapabilities.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    expect(agentCapabilities.tools.map((t) => t.name)).not.toContain("recommend_vehicle");
  });

  test("every tool has all required descriptive fields", () => {
    for (const tool of agentCapabilities.tools) {
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("operation_id");
      expect(tool).toHaveProperty("method");
      expect(tool).toHaveProperty("path");
      expect(tool).toHaveProperty("purpose");
      expect(tool).toHaveProperty("requires_agent_service_auth");
      expect(tool).toHaveProperty("requires_booking_access_token");
      expect(tool).toHaveProperty("requires_idempotency_key");
      expect(tool).toHaveProperty("allowed_stage");
      expect(tool).toHaveProperty("next_tools");
      expect(tool).toHaveProperty("openapi_operation_ref");
      expect(tool.operation_id).toBe(tool.name);
      expect(tool.method).toBe("POST");
    }
  });

  test("every tool requires agent_service_auth", () => {
    for (const tool of agentCapabilities.tools) {
      expect(tool.requires_agent_service_auth).toBe(true);
    }
  });

  test("exactly check_availability and calculate_quote need only service auth (no booking token, no idempotency key)", () => {
    for (const name of ["check_availability", "calculate_quote"]) {
      const tool = agentCapabilities.tools.find((t) => t.name === name);
      expect(tool.requires_booking_access_token).toBe(false);
      expect(tool.requires_idempotency_key).toBe(false);
    }
  });

  test("exactly create_booking_draft requires an Idempotency-Key, and does not require a booking access token", () => {
    const tool = agentCapabilities.tools.find((t) => t.name === "create_booking_draft");
    expect(tool.requires_idempotency_key).toBe(true);
    expect(tool.requires_booking_access_token).toBe(false);
    const others = agentCapabilities.tools.filter((t) => t.name !== "create_booking_draft");
    for (const other of others) {
      expect(other.requires_idempotency_key).toBe(false);
    }
  });

  test("exactly the 5 order-scoped tools require a booking access token", () => {
    const orderScoped = ["get_booking_summary", "update_booking_draft", "confirm_booking_summary", "create_payment_link", "get_payment_status"];
    for (const name of orderScoped) {
      const tool = agentCapabilities.tools.find((t) => t.name === name);
      expect(tool.requires_booking_access_token).toBe(true);
    }
    for (const name of ["check_availability", "calculate_quote", "create_booking_draft"]) {
      const tool = agentCapabilities.tools.find((t) => t.name === name);
      expect(tool.requires_booking_access_token).toBe(false);
    }
  });

  test("each tool's path matches the real pages/api/agent/*.js route", () => {
    const expectedPaths = {
      check_availability: "/api/agent/check-availability",
      calculate_quote: "/api/agent/calculate-quote",
      create_booking_draft: "/api/agent/create-booking-draft",
      get_booking_summary: "/api/agent/get-booking-summary",
      update_booking_draft: "/api/agent/update-booking-draft",
      confirm_booking_summary: "/api/agent/confirm-booking-summary",
      create_payment_link: "/api/agent/create-payment-link",
      get_payment_status: "/api/agent/get-payment-status",
    };
    for (const tool of agentCapabilities.tools) {
      expect(tool.path).toBe(expectedPaths[tool.name]);
    }
  });
});

describe("agentCapabilities — forbidden strings never appear anywhere in the full serialized object", () => {
  const serialized = JSON.stringify(agentCapabilities);
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

  test("does not contain any real secret env-var name's value or a realistic Bearer/token example", () => {
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{20,}/);
    expect(serialized).not.toMatch(/sk_live_|sk_test_|re_[A-Za-z0-9]{16,}/);
  });

  test("does not contain the historical LINE ID", () => {
    expect(serialized).not.toMatch(/okinawacharter/i);
  });
});
