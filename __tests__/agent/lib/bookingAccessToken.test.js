const { issueBookingAccessToken, verifyBookingAccessToken } = require("../../../lib/agent/tokens/bookingAccessToken");
const { AGENT_ERROR_CODES } = require("../../../lib/agent/errorCodes");

describe("bookingAccessToken", () => {
  const ORIGINAL_SECRET = process.env.AGENT_BOOKING_TOKEN_SECRET;

  beforeEach(() => {
    process.env.AGENT_BOOKING_TOKEN_SECRET = "test-hmac-secret-value";
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.AGENT_BOOKING_TOKEN_SECRET;
    else process.env.AGENT_BOOKING_TOKEN_SECRET = ORIGINAL_SECRET;
  });

  test("issue -> verify round trip succeeds for the same order_id", () => {
    const issued = issueBookingAccessToken({ order_id: "ORD-20260725-11111" });
    expect(issued.ok).toBe(true);
    expect(typeof issued.token).toBe("string");

    const verified = verifyBookingAccessToken({ token: issued.token, order_id: "ORD-20260725-11111" });
    expect(verified.ok).toBe(true);
    expect(verified.payload.order_id).toBe("ORD-20260725-11111");
    expect(verified.payload.purpose).toBe("booking_access");
  });

  test("secret env var missing -> issue fails closed with agent_auth_not_configured", () => {
    delete process.env.AGENT_BOOKING_TOKEN_SECRET;
    const issued = issueBookingAccessToken({ order_id: "ORD-1" });
    expect(issued.ok).toBe(false);
    expect(issued.code).toBe(AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED);
  });

  test("secret env var missing -> verify also fails closed with agent_auth_not_configured", () => {
    const issued = issueBookingAccessToken({ order_id: "ORD-1" });
    delete process.env.AGENT_BOOKING_TOKEN_SECRET;
    const verified = verifyBookingAccessToken({ token: issued.token, order_id: "ORD-1" });
    expect(verified.ok).toBe(false);
    expect(verified.code).toBe(AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED);
  });

  test("expired token -> booking_access_expired", () => {
    const issued = issueBookingAccessToken({ order_id: "ORD-1", ttlMs: -1000 }); // already expired
    const verified = verifyBookingAccessToken({ token: issued.token, order_id: "ORD-1" });
    expect(verified.ok).toBe(false);
    expect(verified.code).toBe(AGENT_ERROR_CODES.BOOKING_ACCESS_EXPIRED);
  });

  test("order_id mismatch -> booking_access_order_mismatch", () => {
    const issued = issueBookingAccessToken({ order_id: "ORD-A" });
    const verified = verifyBookingAccessToken({ token: issued.token, order_id: "ORD-B" });
    expect(verified.ok).toBe(false);
    expect(verified.code).toBe(AGENT_ERROR_CODES.BOOKING_ACCESS_ORDER_MISMATCH);
  });

  test("tampered payload (order_id swapped after issuance, signature no longer matches) -> booking_access_invalid, not order_mismatch", () => {
    const issued = issueBookingAccessToken({ order_id: "ORD-A" });
    const dotIndex = issued.token.lastIndexOf(".");
    const payloadB64 = issued.token.slice(0, dotIndex);
    const sig = issued.token.slice(dotIndex + 1);
    const tamperedPayload = Buffer.from(JSON.stringify({ order_id: "ORD-B", purpose: "booking_access", issued_at: Date.now(), expires_at: Date.now() + 60000 })).toString("base64url");
    const tamperedToken = `${tamperedPayload}.${sig}`;

    const verified = verifyBookingAccessToken({ token: tamperedToken, order_id: "ORD-B" });
    expect(verified.ok).toBe(false);
    expect(verified.code).toBe(AGENT_ERROR_CODES.BOOKING_ACCESS_INVALID);
  });

  test("wrong purpose in an otherwise well-signed token -> booking_access_invalid", () => {
    const secret = process.env.AGENT_BOOKING_TOKEN_SECRET;
    const crypto = require("crypto");
    const payload = { order_id: "ORD-1", purpose: "payment", issued_at: Date.now(), expires_at: Date.now() + 60000 };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto.createHmac("sha256", secret).update(payloadB64, "utf8").digest("hex");
    const token = `${payloadB64}.${sig}`;

    const verified = verifyBookingAccessToken({ token, order_id: "ORD-1" });
    expect(verified.ok).toBe(false);
    expect(verified.code).toBe(AGENT_ERROR_CODES.BOOKING_ACCESS_INVALID);
  });

  test("malformed token (no dot separator) -> booking_access_invalid, does not throw", () => {
    expect(() => verifyBookingAccessToken({ token: "not-a-real-token", order_id: "ORD-1" })).not.toThrow();
    const verified = verifyBookingAccessToken({ token: "not-a-real-token", order_id: "ORD-1" });
    expect(verified.code).toBe(AGENT_ERROR_CODES.BOOKING_ACCESS_INVALID);
  });

  test("empty/missing token -> booking_access_invalid", () => {
    expect(verifyBookingAccessToken({ token: undefined, order_id: "ORD-1" }).code).toBe(AGENT_ERROR_CODES.BOOKING_ACCESS_INVALID);
    expect(verifyBookingAccessToken({ token: "", order_id: "ORD-1" }).code).toBe(AGENT_ERROR_CODES.BOOKING_ACCESS_INVALID);
  });

  test("the exported API surface has no payment-authorization function — only issue/verify for read access", () => {
    const mod = require("../../../lib/agent/tokens/bookingAccessToken");
    const exportedNames = Object.keys(mod).join(",").toLowerCase();
    expect(exportedNames).not.toMatch(/pay|charge|confirm/);
    expect(mod.PURPOSE).toBe("booking_access");
  });
});
