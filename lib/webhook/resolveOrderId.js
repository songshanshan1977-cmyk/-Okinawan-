// lib/webhook/resolveOrderId.js
//
// Resolves which order_id a Stripe checkout.session.completed event refers
// to, from the two possible carriers Stripe offers: session.metadata.order_id
// and session.client_reference_id. Both are set by our own create-payment-intent
// call, so in the legitimate flow they are always equal (or one is absent).
// A disagreement between them is not expected to ever happen naturally and
// is treated as a security-relevant anomaly, not a data-quality nuisance.

const RESULT = {
  MISSING: "missing", // neither carrier present -> silently ignore (200, no write)
  OK: "ok", // exactly one usable order_id, no conflict
  UNRESOLVABLE_CONFLICT: "unresolvable_conflict", // disagree, can't safely pick one -> 5xx + security log
  RESOLVED_CONFLICT: "resolved_conflict", // disagree, but exactly one candidate is a real order -> proceed with p_id_source_conflict=true
};

/**
 * @param {object} params
 * @param {object} params.supabase
 * @param {string|null|undefined} params.metadataOrderId
 * @param {string|null|undefined} params.clientReferenceId
 * @returns {Promise<{status:string, orderId:string|null}>}
 */
async function resolveOrderId({ supabase, metadataOrderId, clientReferenceId }) {
  const a = metadataOrderId || null;
  const b = clientReferenceId || null;

  if (!a && !b) {
    return { status: RESULT.MISSING, orderId: null };
  }
  if (!a || !b || a === b) {
    return { status: RESULT.OK, orderId: a || b };
  }

  // a !== b, both present: check which (if either) exists as a real order.
  const { data, error } = await supabase.from("orders").select("order_id").in("order_id", [a, b]);

  if (error) {
    // Existence check itself failed (DB/network) — cannot safely resolve.
    return { status: RESULT.UNRESOLVABLE_CONFLICT, orderId: null };
  }

  const found = new Set((data || []).map((r) => r.order_id));
  const aExists = found.has(a);
  const bExists = found.has(b);

  if (aExists && !bExists) {
    return { status: RESULT.RESOLVED_CONFLICT, orderId: a };
  }
  if (bExists && !aExists) {
    return { status: RESULT.RESOLVED_CONFLICT, orderId: b };
  }
  // Neither exists, or both exist as two distinct real orders: no reliable
  // way to pick one — do not guess.
  return { status: RESULT.UNRESOLVABLE_CONFLICT, orderId: null };
}

module.exports = { resolveOrderId, RESULT };
