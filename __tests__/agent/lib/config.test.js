const { getValidatedAgentSecret, MIN_SECRET_LENGTH } = require("../../../lib/agent/config");
const { TEST_AGENT_SERVICE_KEY, TEST_AGENT_BOOKING_TOKEN_SECRET, TEST_SHORT_SECRET } = require("../helpers/testSecrets");

describe("lib/agent/config — getValidatedAgentSecret", () => {
  const ORIGINAL_A = process.env.AGENT_SERVICE_KEY;
  const ORIGINAL_B = process.env.AGENT_BOOKING_TOKEN_SECRET;

  afterEach(() => {
    if (ORIGINAL_A === undefined) delete process.env.AGENT_SERVICE_KEY;
    else process.env.AGENT_SERVICE_KEY = ORIGINAL_A;
    if (ORIGINAL_B === undefined) delete process.env.AGENT_BOOKING_TOKEN_SECRET;
    else process.env.AGENT_BOOKING_TOKEN_SECRET = ORIGINAL_B;
  });

  test("MIN_SECRET_LENGTH is 32 bytes", () => {
    expect(MIN_SECRET_LENGTH).toBe(32);
  });

  test("two distinct, long-enough secrets both validate successfully", () => {
    process.env.AGENT_SERVICE_KEY = TEST_AGENT_SERVICE_KEY;
    process.env.AGENT_BOOKING_TOKEN_SECRET = TEST_AGENT_BOOKING_TOKEN_SECRET;

    expect(getValidatedAgentSecret("AGENT_SERVICE_KEY", "AGENT_BOOKING_TOKEN_SECRET")).toBe(TEST_AGENT_SERVICE_KEY);
    expect(getValidatedAgentSecret("AGENT_BOOKING_TOKEN_SECRET", "AGENT_SERVICE_KEY")).toBe(TEST_AGENT_BOOKING_TOKEN_SECRET);
  });

  test("missing env var -> null", () => {
    delete process.env.AGENT_SERVICE_KEY;
    process.env.AGENT_BOOKING_TOKEN_SECRET = TEST_AGENT_BOOKING_TOKEN_SECRET;
    expect(getValidatedAgentSecret("AGENT_SERVICE_KEY", "AGENT_BOOKING_TOKEN_SECRET")).toBeNull();
  });

  test("too-short secret (< 32 bytes) -> null, even though it is non-blank", () => {
    process.env.AGENT_SERVICE_KEY = TEST_SHORT_SECRET;
    process.env.AGENT_BOOKING_TOKEN_SECRET = TEST_AGENT_BOOKING_TOKEN_SECRET;
    expect(Buffer.byteLength(TEST_SHORT_SECRET)).toBeLessThan(32);
    expect(getValidatedAgentSecret("AGENT_SERVICE_KEY", "AGENT_BOOKING_TOKEN_SECRET")).toBeNull();
  });

  test("the two Agent secrets set to the SAME value -> BOTH fail closed (null from either direction)", () => {
    const shared = TEST_AGENT_SERVICE_KEY; // reused verbatim as both env vars below
    process.env.AGENT_SERVICE_KEY = shared;
    process.env.AGENT_BOOKING_TOKEN_SECRET = shared;

    expect(getValidatedAgentSecret("AGENT_SERVICE_KEY", "AGENT_BOOKING_TOKEN_SECRET")).toBeNull();
    expect(getValidatedAgentSecret("AGENT_BOOKING_TOKEN_SECRET", "AGENT_SERVICE_KEY")).toBeNull();
  });

  test("exactly 32 bytes (the boundary) validates successfully", () => {
    const exact32 = "x".repeat(32);
    process.env.AGENT_SERVICE_KEY = exact32;
    process.env.AGENT_BOOKING_TOKEN_SECRET = TEST_AGENT_BOOKING_TOKEN_SECRET;
    expect(getValidatedAgentSecret("AGENT_SERVICE_KEY", "AGENT_BOOKING_TOKEN_SECRET")).toBe(exact32);
  });

  test("31 bytes (one under the boundary) fails", () => {
    process.env.AGENT_SERVICE_KEY = "x".repeat(31);
    process.env.AGENT_BOOKING_TOKEN_SECRET = TEST_AGENT_BOOKING_TOKEN_SECRET;
    expect(getValidatedAgentSecret("AGENT_SERVICE_KEY", "AGENT_BOOKING_TOKEN_SECRET")).toBeNull();
  });

  test("never throws for any input shape", () => {
    delete process.env.AGENT_SERVICE_KEY;
    delete process.env.AGENT_BOOKING_TOKEN_SECRET;
    expect(() => getValidatedAgentSecret("AGENT_SERVICE_KEY", "AGENT_BOOKING_TOKEN_SECRET")).not.toThrow();
  });
});
