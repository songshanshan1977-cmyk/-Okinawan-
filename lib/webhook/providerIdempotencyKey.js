// lib/webhook/providerIdempotencyKey.js
//
// R3 §二: the Resend Idempotency-Key sent to the provider must never be
// the raw dedupe_key (order_id:stripe_session_id:audience:notification_type
// — arbitrarily long, and its own components are exactly the readable IDs
// this whole engagement has been scrubbing out of every other outward-
// facing surface). Instead it's a stable, one-way SHA-256 digest of the
// dedupe_key: same dedupe_key -> same key forever, different dedupe_key ->
// different key, and nothing about the original order/session is
// recoverable from it. Computed once in Node (not SQL) and then frozen
// into the database by freeze_webhook_notification_payload_v1 — every
// retry reads the ALREADY-frozen value back, it is never recomputed and
// overwritten.

const crypto = require("crypto");

function computeProviderIdempotencyKey(dedupeKey) {
  const digest = crypto.createHash("sha256").update(String(dedupeKey)).digest("hex");
  return `webhook-${digest}`;
}

module.exports = { computeProviderIdempotencyKey };
