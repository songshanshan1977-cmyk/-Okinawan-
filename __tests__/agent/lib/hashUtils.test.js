const { computeFieldsHash, normalizeHashValue } = require("../../../lib/agent/hashUtils");

// The OLD, buggy scheme this file replaces (A1-B04) — reconstructed here
// ONLY to prove it collides on the fixtures below, never used in product
// code anymore.
function oldUnsafeJoin(fields, row) {
  const crypto = require("crypto");
  const parts = fields.map((key) => `${key}=${row[key] === undefined || row[key] === null ? "" : row[key]}`);
  return crypto.createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
}

describe("lib/agent/hashUtils — computeFieldsHash (A1-B04)", () => {
  const FIELDS = ["a", "b"];

  test("the OLD `key=value` + `|` join scheme genuinely collides for two different rows", () => {
    // a value containing the literal "|nextKey=" pattern can make two
    // different (key,value) sets serialize to the identical joined string.
    const rowA = { a: "1|b=2", b: "3" };
    const rowB = { a: "1", b: "2|b=3" };

    expect(rowA).not.toEqual(rowB); // genuinely different content
    expect(oldUnsafeJoin(FIELDS, rowA)).toBe(oldUnsafeJoin(FIELDS, rowB)); // yet the OLD scheme collides
  });

  test("the NEW computeFieldsHash does NOT collide on that same pair", () => {
    const rowA = { a: "1|b=2", b: "3" };
    const rowB = { a: "1", b: "2|b=3" };

    expect(computeFieldsHash(FIELDS, rowA)).not.toBe(computeFieldsHash(FIELDS, rowB));
  });

  test("values containing raw `=` do not collide with a different split of the same characters", () => {
    const rowA = { a: "x=y", b: "z" };
    const rowB = { a: "x", b: "=y|z" };
    expect(computeFieldsHash(FIELDS, rowA)).not.toBe(computeFieldsHash(FIELDS, rowB));
  });

  test("values containing double quotes are handled safely and do not collide with an unescaped variant", () => {
    const rowA = { a: 'say "hello"', b: "1" };
    const rowB = { a: "say \\\"hello\\\"", b: "1" }; // a literal backslash-quote sequence, not the same string
    expect(computeFieldsHash(FIELDS, rowA)).not.toBe(computeFieldsHash(FIELDS, rowB));
    expect(() => computeFieldsHash(FIELDS, rowA)).not.toThrow();
  });

  test("Unicode values (CJK + emoji) hash safely and distinctly", () => {
    const rowA = { a: "冲绳包车 🚗", b: "东京" };
    const rowB = { a: "冲绳包车 🚙", b: "东京" }; // different emoji only
    expect(() => computeFieldsHash(FIELDS, rowA)).not.toThrow();
    expect(computeFieldsHash(FIELDS, rowA)).not.toBe(computeFieldsHash(FIELDS, rowB));
  });

  test("stable for identical input", () => {
    const row = { a: "x", b: "y" };
    expect(computeFieldsHash(FIELDS, { ...row })).toBe(computeFieldsHash(FIELDS, { ...row }));
  });

  test("undefined and null normalize to the same canonical value", () => {
    expect(normalizeHashValue(undefined)).toBe(normalizeHashValue(null));
    expect(computeFieldsHash(FIELDS, { a: undefined, b: "x" })).toBe(computeFieldsHash(FIELDS, { a: null, b: "x" }));
  });

  test("field order in FIELDS matters (not a set — order is part of the encoding)", () => {
    const row = { a: "1", b: "2" };
    expect(computeFieldsHash(["a", "b"], row)).not.toBe(computeFieldsHash(["b", "a"], row));
  });

  test("output is a 64-char lowercase hex SHA-256 digest", () => {
    const hash = computeFieldsHash(FIELDS, { a: "1", b: "2" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
