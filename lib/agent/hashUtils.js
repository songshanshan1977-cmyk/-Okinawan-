// lib/agent/hashUtils.js
//
// A1-B04: shared, unambiguous field-hashing helper. Replaces the original
// getBookingSummary.js scheme (`key=value` parts joined with `|`), which
// was NOT collision-free: a value that itself contains "|" or "=" can make
// two DIFFERENT sets of field values serialize to the IDENTICAL joined
// string. For example, with fields iterated in a fixed order, a row where
// one field's value ends in `|nextFieldName=X` can collide with a row where
// that literal text is genuinely split across two separate fields — the
// naive delimiter-joined string cannot tell the difference.
//
// Fix: encode as JSON.stringify of an ordered array of [key, normalizedValue]
// pairs. JSON's own string escaping (of quotes, backslashes, and Unicode)
// combined with JSON array/string structural delimiters makes the encoding
// unambiguous — there is no way for a value's content to be misread as a
// key/value or field boundary, because JSON string values are always
// unambiguously delimited by their own escaped quotes, not by a
// caller-controllable raw character like `|` or `=`.
//
// Used by both lib/agent/tools/getBookingSummary.js (summary_hash) and
// lib/agent/tools/createBookingDraft.js (idempotency request_hash) so the
// two hashes are computed with the exact same collision-free primitive.

const crypto = require("crypto");

// Canonicalizes a single field value before hashing: undefined/null both
// collapse to the single canonical `null` (JSON null), everything else is
// passed through as-is (JSON.stringify handles number/string/boolean
// escaping correctly on its own).
function normalizeHashValue(v) {
  if (v === undefined || v === null) return null;
  return v;
}

/**
 * @param {string[]} fields - ordered list of field names to include
 * @param {object} row - source object to read field values from
 * @returns {string} lowercase hex SHA-256 digest
 */
function computeFieldsHash(fields, row) {
  const encoded = JSON.stringify(fields.map((key) => [key, normalizeHashValue(row ? row[key] : undefined)]));
  return crypto.createHash("sha256").update(encoded, "utf8").digest("hex");
}

module.exports = { normalizeHashValue, computeFieldsHash };
