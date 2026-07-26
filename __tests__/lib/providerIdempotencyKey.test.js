const { computeProviderIdempotencyKey } = require("../../lib/webhook/providerIdempotencyKey");

describe("computeProviderIdempotencyKey (R3 §二)", () => {
  test("6. same dedupe_key always produces the same provider key", () => {
    const key = "ORD-20260722-11111:cs_test_1:customer:customer_booking_confirmed";
    expect(computeProviderIdempotencyKey(key)).toBe(computeProviderIdempotencyKey(key));
  });

  test("different dedupe_key produces a different provider key", () => {
    const a = computeProviderIdempotencyKey("ORD-1:cs_1:customer:customer_booking_confirmed");
    const b = computeProviderIdempotencyKey("ORD-1:cs_1:ops:ops_booking_confirmed");
    expect(a).not.toBe(b);
  });

  test("3/4. format is webhook-<hex>, and total length is well under 256 chars even for a very long dedupe_key", () => {
    const veryLongKey = "ORD-" + "X".repeat(500) + ":cs_test_" + "Y".repeat(500) + ":customer:customer_booking_confirmed";
    const provKey = computeProviderIdempotencyKey(veryLongKey);
    expect(provKey).toMatch(/^webhook-[0-9a-f]{64}$/);
    expect(provKey.length).toBeLessThan(256);
  });

  test("10. does not contain a readable prefix/suffix of the original order_id or session_id", () => {
    const key = "ORD-20260722-11111:cs_test_abcdefghijklmnop:customer:customer_manual_review";
    const provKey = computeProviderIdempotencyKey(key);
    expect(provKey).not.toContain("ORD-20260722-11111");
    expect(provKey).not.toContain("cs_test_abcdefghijklmnop");
  });
});
