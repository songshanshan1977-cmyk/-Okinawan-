const { logAgentToolCall, maskOrderId } = require("../../../lib/agent/audit");

describe("lib/agent/audit", () => {
  let infoSpy, warnSpy;
  beforeEach(() => {
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("order_id is masked, never logged in the clear", () => {
    logAgentToolCall({ tool_name: "get_booking_summary", order_id: "ORD-20260901-11111", outcome: "success" });
    const logged = JSON.stringify(infoSpy.mock.calls[0]);
    expect(logged).not.toMatch(/ORD-20260901-11111/);
    expect(logged).toMatch(/order#[0-9a-f]{12}/);
  });

  test("masking is deterministic (same order_id -> same masked value every call)", () => {
    expect(maskOrderId("ORD-1")).toBe(maskOrderId("ORD-1"));
    expect(maskOrderId("ORD-1")).not.toBe(maskOrderId("ORD-2"));
  });

  test("masking is irreversible-looking (not a truncation/prefix of the original)", () => {
    const masked = maskOrderId("ORD-20260901-11111");
    expect(masked).not.toMatch(/20260901/);
    expect(masked).not.toMatch(/11111/);
  });

  test("log payload has EXACTLY the whitelisted fields, nothing else can be injected through extra call-site args", () => {
    logAgentToolCall({
      tool_name: "create_booking_draft",
      order_id: "ORD-1",
      outcome: "failure",
      error_code: "invalid_request",
      // an accidental/malicious extra field a careless call site might add:
      booking_access_token: "should-never-be-logged",
      name: "Zhang San",
      raw_body: { email: "z@example.com" },
    });
    const [, payload] = warnSpy.mock.calls[0];
    const parsed = JSON.parse(payload);
    expect(Object.keys(parsed).sort()).toEqual(["error_code", "order_id", "outcome", "timestamp", "tool_name"].sort());
  });

  test("success logs via console.info, failure logs via console.warn", () => {
    logAgentToolCall({ tool_name: "check_availability", outcome: "success" });
    logAgentToolCall({ tool_name: "check_availability", outcome: "failure", error_code: "invalid_request" });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("missing order_id (e.g. check_availability, which is not order-scoped) logs null, not undefined/crash", () => {
    expect(() => logAgentToolCall({ tool_name: "check_availability", outcome: "success" })).not.toThrow();
    const parsed = JSON.parse(infoSpy.mock.calls[0][1]);
    expect(parsed.order_id).toBeNull();
  });
});
