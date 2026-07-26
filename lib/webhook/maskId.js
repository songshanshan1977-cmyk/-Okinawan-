// lib/webhook/maskId.js
//
// R2-B05/N-01/N-02: a prefix+suffix "mask" is still the ORIGINAL ID data —
// anyone who saw a handful of real Stripe Session IDs for this account
// could plausibly guess the untruncated middle, and two log lines from the
// same object are trivially linkable by their shared prefix/suffix. This
// round replaces that with an irreversible, one-way stable digest: no
// substring of the original ID appears anywhere in the output, but the
// SAME input always produces the SAME output, so operators can still grep
// logs for "does this ID show up elsewhere" without ever seeing the ID
// itself. Applies uniformly to event.id, session.id, payment_intent,
// claim_token, provider_message_id, and any other third-party identifier.

const crypto = require("crypto");

function maskId(id) {
  if (!id) return "-";
  const digest = crypto.createHash("sha256").update(String(id)).digest("hex");
  return `id#${digest.slice(0, 12)}`;
}

module.exports = { maskId };
