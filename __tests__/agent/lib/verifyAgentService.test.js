const { verifyAgentService, extractBearerToken, timingSafeStringEqual } = require("../../../lib/agent/auth/verifyAgentService");
const { AGENT_ERROR_CODES } = require("../../../lib/agent/errorCodes");

describe("verifyAgentService", () => {
  const ORIGINAL_KEY = process.env.AGENT_SERVICE_KEY;

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.AGENT_SERVICE_KEY;
    else process.env.AGENT_SERVICE_KEY = ORIGINAL_KEY;
  });

  test("env var missing -> fail-closed agent_auth_not_configured, never falls back to a default", () => {
    delete process.env.AGENT_SERVICE_KEY;
    const result = verifyAgentService({ headers: { authorization: "Bearer anything" } });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED);
  });

  test("env var blank string -> also fail-closed agent_auth_not_configured", () => {
    process.env.AGENT_SERVICE_KEY = "   ";
    const result = verifyAgentService({ headers: { authorization: "Bearer anything" } });
    expect(result.code).toBe(AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED);
  });

  test("missing Authorization header -> agent_unauthorized", () => {
    process.env.AGENT_SERVICE_KEY = "correct-service-key";
    const result = verifyAgentService({ headers: {} });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.AGENT_UNAUTHORIZED);
  });

  test("malformed header (no Bearer prefix) -> agent_unauthorized", () => {
    process.env.AGENT_SERVICE_KEY = "correct-service-key";
    const result = verifyAgentService({ headers: { authorization: "correct-service-key" } });
    expect(result.code).toBe(AGENT_ERROR_CODES.AGENT_UNAUTHORIZED);
  });

  test("wrong token -> agent_unauthorized", () => {
    process.env.AGENT_SERVICE_KEY = "correct-service-key";
    const result = verifyAgentService({ headers: { authorization: "Bearer wrong-key" } });
    expect(result.code).toBe(AGENT_ERROR_CODES.AGENT_UNAUTHORIZED);
  });

  test("wrong token of a totally different length -> still agent_unauthorized, does not throw", () => {
    process.env.AGENT_SERVICE_KEY = "correct-service-key";
    expect(() => verifyAgentService({ headers: { authorization: "Bearer x" } })).not.toThrow();
    const result = verifyAgentService({ headers: { authorization: "Bearer x" } });
    expect(result.code).toBe(AGENT_ERROR_CODES.AGENT_UNAUTHORIZED);
  });

  test("correct token -> ok:true", () => {
    process.env.AGENT_SERVICE_KEY = "correct-service-key";
    const result = verifyAgentService({ headers: { authorization: "Bearer correct-service-key" } });
    expect(result).toEqual({ ok: true });
  });

  test("timingSafeStringEqual: equal strings of different length inputs never throw", () => {
    expect(() => timingSafeStringEqual("short", "a-much-longer-string-value")).not.toThrow();
    expect(timingSafeStringEqual("same", "same")).toBe(true);
    expect(timingSafeStringEqual("same", "diff")).toBe(false);
  });

  test("extractBearerToken parses correctly and rejects non-Bearer schemes", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
    expect(extractBearerToken("Basic abc123")).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });

  test("no CORS wildcard: this module never sets any response header itself", () => {
    // verifyAgentService only ever reads req.headers — it takes no `res`
    // parameter at all, so it is structurally incapable of setting
    // Access-Control-Allow-Origin or any other response header.
    expect(verifyAgentService.length).toBe(1);
  });
});
