const { maskId } = require("../../lib/webhook/maskId");

describe("maskId (R2-B05/N-01/N-02: irreversible, not truncation)", () => {
  test("falsy input -> '-'", () => {
    expect(maskId(null)).toBe("-");
    expect(maskId(undefined)).toBe("-");
    expect(maskId("")).toBe("-");
  });

  test("19. a short ID is not returned as-is", () => {
    const short = "cs_1";
    const masked = maskId(short);
    expect(masked).not.toBe(short);
    expect(masked).not.toContain(short);
  });

  test("19. a long ID is not returned as-is, and no prefix/suffix substring of it survives", () => {
    const long = "cs_test_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0";
    const masked = maskId(long);
    expect(masked).not.toBe(long);
    expect(masked).not.toContain(long.slice(0, 8));
    expect(masked).not.toContain(long.slice(-8));
    expect(masked).not.toContain(long.slice(0, 4));
    expect(masked).not.toContain(long.slice(-4));
  });

  test("stable: same input always produces the same output", () => {
    const id = "evt_stableid1234567890";
    expect(maskId(id)).toBe(maskId(id));
  });

  test("different inputs produce different outputs (no collisions for realistic IDs)", () => {
    expect(maskId("cs_test_aaaa")).not.toBe(maskId("cs_test_bbbb"));
  });

  test("output format is a fixed-width hex digest label, not the input's own shape", () => {
    const masked = maskId("cs_test_someRealisticStripeSessionId123456789");
    expect(masked).toMatch(/^id#[0-9a-f]{12}$/);
  });
});
