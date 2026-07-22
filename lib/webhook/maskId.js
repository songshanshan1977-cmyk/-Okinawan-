// lib/webhook/maskId.js
//
// B-05: nothing that identifies a specific Stripe object (Session ID,
// Event ID, PaymentIntent ID) or lets someone else replay it may appear in
// full in logs or in operational email content. Always show a short,
// non-reversible-enough prefix+suffix instead.

function maskId(id) {
  if (!id) return "-";
  const s = String(id);
  if (s.length <= 12) return s;
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

module.exports = { maskId };
