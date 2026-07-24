// pages/api/stripe-webhook.js
//
// v1 fail-safe rewrite (sandbox/webhook-fail-safe-v1), revised across three
// Codex review rounds. All business-content writes (orders/payments/
// inventory/notification outbox) happen inside the single atomic
// process_checkout_payment_v1 RPC (see supabase/migrations/
// 20260722120000_webhook_fail_safe_v1.sql). This handler's job is limited
// to: verify the Stripe signature, filter/validate the event, resolve
// which order it refers to, call the RPC, then claim/freeze/send/complete
// every outstanding notification via the send_logs outbox (see
// 20260722130000_webhook_notification_outbox_v1.sql) — it never marks an
// order "paid" on its own, never decides email-sent state via the legacy
// per-order boolean email flags on orders, and no exception path returns
// 200 — only genuinely inert cases (unrelated event, unpaid session,
// unresolvable order_id) do.
//
// R3 §四: SENDER_EMAIL and OPS_EMAIL_TO come from exactly one environment
// variable each (RESEND_FROM, NOTIFY_TO_EMAIL) with NO hardcoded fallback.
// Either being missing/blank fails the affected notification closed — it
// is never silently sent from/to a baked-in address.
//
// R2-B05/N-01/N-02: no log line in this file may contain a Stripe Session
// ID, Event ID, PaymentIntent ID, claim_token, provider_message_id, or any
// customer PII — always go through maskId() (irreversible hash, not a
// truncation). No log line may contain a raw Supabase/Postgres error
// object, error.message/details/hint, SQL text, constraint name, table
// name, or connection info — every failure is logged as one of a small
// set of stable string codes, never the underlying error's own text.

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

const { resolveOrderId, RESULT } = require("../../lib/webhook/resolveOrderId");
const { buildNotificationContent } = require("../../lib/webhook/notificationContent");
const { maskId } = require("../../lib/webhook/maskId");
const { computeProviderIdempotencyKey } = require("../../lib/webhook/providerIdempotencyKey");

export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2022-11-15",
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

// R3 §四: exactly one official env var each, NO hardcoded fallback. A
// missing/blank value is a real production misconfiguration, not
// something this code should silently paper over with a baked-in address.
const SENDER_EMAIL = process.env.RESEND_FROM;
const OPS_EMAIL_TO = process.env.NOTIFY_TO_EMAIL;

function isBlank(v) {
  return !v || String(v).trim().length === 0;
}

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Truncation for content that DOES get persisted to the DB (send_logs
// .error_message, via complete_webhook_notification_v1's own p_error_message
// param — the migration truncates it again server-side too). This is
// separate from, and much less strict than, what is allowed in a
// console.* call: a queryable DB column is not the same exposure surface
// as an application log stream.
function safeTruncateForDb(msg, max = 300) {
  const s = msg ? String(msg) : "unknown_error";
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

// R2-B01: the strict result contract for every RPC in this file that
// returns a jsonb {ok, ...} envelope (freeze_webhook_notification_payload_v1,
// complete_webhook_notification_v1). ALL of the following count as "not
// ok" and must never be treated as success:
//   - a top-level Supabase/PostgREST error
//   - data is null/undefined
//   - data.ok is not literally true
function isRpcEnvelopeOk({ data, error }) {
  return !error && !!data && data.ok === true;
}

// R2-B03/R3 §一: the installed Resend SDK's response shape is
// `{ data: { id } | null, error: ErrorResponse | null }` — a resolved
// promise is NOT proof of delivery. `from`/`to`/`subject`/`html` and the
// Idempotency-Key MUST all come from the caller's already-frozen payload —
// this function never reads SENDER_EMAIL or rebuilds content itself.
async function sendViaResend({ from, to, subject, html, idempotencyKey }) {
  let response;
  try {
    response = await resend.emails.send({ from, to, subject, html }, { idempotencyKey });
  } catch (err) {
    return { ok: false, errorMessage: safeTruncateForDb(err && err.message) };
  }

  const { data, error } = response || {};
  if (error) {
    return { ok: false, errorMessage: safeTruncateForDb(error.message || JSON.stringify(error)) };
  }
  if (!data || !data.id) {
    return { ok: false, errorMessage: "resend_response_missing_message_id" };
  }
  return { ok: true, providerMessageId: data.id };
}

async function completeNotification({ dedupeKey, claimToken, outcome, providerMessageId, errorMessage }) {
  return supabase.rpc("complete_webhook_notification_v1", {
    p_dedupe_key: dedupeKey,
    p_claim_token: claimToken,
    p_outcome: outcome,
    p_provider_message_id: providerMessageId || null,
    p_error_message: errorMessage || null,
  });
}

// R2 §四 / R3 §一/§二: claim/freeze/send/complete one already-claimed
// outbox row. Recovers correctly no matter where a PREVIOUS attempt died
// (before claiming, between claim and Resend, between Resend accepting
// the email and complete()) — see the round's completion report for the
// full recovery-path breakdown. R3 additions:
//   - the frozen payload now covers the SENDER address and the
//     provider_idempotency_key too, not just recipient/subject/html, so a
//     retry can never pair the same Idempotency-Key with a different
//     `from` even if RESEND_FROM changes between attempts;
//   - SENDER_EMAIL / OPS_EMAIL_TO missing now fails the row closed instead
//     of silently substituting a hardcoded address — there is no fallback
//     left to fall back to.
async function processClaimedRow({ row, order, reason, stripeSessionId, attemptedOrderId, existingOrderId }) {
  if (isBlank(SENDER_EMAIL)) {
    // Infrastructure/config problem, not row-specific — potentially
    // transient (a redeploy with the env var set fixes it), stays
    // retryable. Never calls Resend, never freezes a payload with a blank
    // sender.
    const completeResult = await completeNotification({
      dedupeKey: row.dedupe_key,
      claimToken: row.claim_token,
      outcome: "failed",
      errorMessage: "missing_sender_email",
    });
    if (!isRpcEnvelopeOk(completeResult)) console.error("[webhook] complete_rpc_failed");
    return false;
  }

  const content = buildNotificationContent({
    notificationType: row.notification_type,
    order,
    reason,
    stripeSessionId,
    opsEmailTo: OPS_EMAIL_TO,
    attemptedOrderId,
    existingOrderId,
  });

  if (!content) {
    // Defensive: a notification_type this webhook doesn't recognize.
    // Should never happen for a row this webhook itself inserted — stays
    // retryable (a future deploy might simply be missing a case), not a
    // customer-visible or permanent problem.
    const completeResult = await completeNotification({
      dedupeKey: row.dedupe_key,
      claimToken: row.claim_token,
      outcome: "failed",
      errorMessage: "unknown_notification_type",
    });
    if (!isRpcEnvelopeOk(completeResult)) console.error("[webhook] complete_rpc_failed");
    console.error("[webhook] notification_content_invalid");
    return false;
  }

  if (isBlank(content.to)) {
    if (row.audience === "customer") {
      // R2-B03: a missing customer email is a DETERMINISTIC data problem —
      // retrying will never produce an email address. Dead-letter it
      // immediately rather than waiting out the 23h auto-retry window.
      // R3 §三: complete_webhook_notification_v1 itself atomically inserts
      // a dedicated ops_missing_customer_email alert row when it sees this
      // exact (outcome='dead_letter', error_message='missing_customer_email')
      // combination — nothing further to do here. This does NOT force the
      // whole webhook to 5xx: the matching alert gets its own claim/send
      // chance (see the second claim pass below), and once THAT succeeds
      // the webhook can return 200.
      const completeResult = await completeNotification({
        dedupeKey: row.dedupe_key,
        claimToken: row.claim_token,
        outcome: "dead_letter",
        errorMessage: "missing_customer_email",
      });
      if (!isRpcEnvelopeOk(completeResult)) {
        console.error("[webhook] complete_rpc_failed");
        return false;
      }
      return true;
    }
    // Ops recipient missing (NOTIFY_TO_EMAIL unset/blank) IS potentially
    // transient (a redeploy with the env var set fixes it) — stays
    // retryable, never silently sent anywhere else.
    const completeResult = await completeNotification({
      dedupeKey: row.dedupe_key,
      claimToken: row.claim_token,
      outcome: "failed",
      errorMessage: "missing_ops_recipient",
    });
    if (!isRpcEnvelopeOk(completeResult)) console.error("[webhook] complete_rpc_failed");
    return false;
  }

  const providerIdempotencyKey = computeProviderIdempotencyKey(row.dedupe_key);

  const freezeResult = await supabase.rpc("freeze_webhook_notification_payload_v1", {
    p_dedupe_key: row.dedupe_key,
    p_claim_token: row.claim_token,
    p_sender_email: SENDER_EMAIL,
    p_recipient_email: content.to,
    p_email_subject: content.mail.subject,
    p_email_html: content.mail.html,
    p_provider_idempotency_key: providerIdempotencyKey,
  });

  if (!isRpcEnvelopeOk(freezeResult)) {
    console.error("[webhook] freeze_rpc_failed");
    return false;
  }

  // R3 §一 item 6/7: use ONLY the database-returned frozen payload for the
  // actual send — never SENDER_EMAIL or the candidate `content` built
  // above (a concurrent delivery may have frozen different values first).
  const frozen = freezeResult.data.frozen;

  const sendResult = await sendViaResend({
    from: frozen.from,
    to: frozen.to,
    subject: frozen.subject,
    html: frozen.html,
    idempotencyKey: frozen.provider_idempotency_key,
  });

  if (!sendResult.ok) {
    console.error("[webhook] provider_send_failed");
  }

  const completeResult = await completeNotification({
    dedupeKey: row.dedupe_key,
    claimToken: row.claim_token,
    outcome: sendResult.ok ? "sent" : "failed",
    providerMessageId: sendResult.ok ? sendResult.providerMessageId : null,
    errorMessage: sendResult.ok ? null : sendResult.errorMessage,
  });

  if (!isRpcEnvelopeOk(completeResult)) {
    console.error("[webhook] complete_rpc_failed");
    return false;
  }

  return sendResult.ok;
}

async function claimAndProcessOnce({ orderId, sessionId, order, reason, existingOrderId }) {
  const { data: claimed, error: claimError } = await supabase.rpc("claim_webhook_notification_v1", {
    p_order_id: orderId,
    p_stripe_session_id: sessionId,
  });

  if (claimError) {
    console.error("[webhook] claim_rpc_failed");
    return null;
  }

  const rows = claimed || [];
  let allOk = true;

  for (const row of rows) {
    const rowOk = await processClaimedRow({
      row,
      order,
      reason,
      stripeSessionId: sessionId,
      attemptedOrderId: orderId,
      existingOrderId,
    });
    if (!rowOk) allOk = false;
  }

  return allOk;
}

// R3 §三: a customer row dead-lettering for a missing email atomically
// creates a NEW ops_missing_customer_email outbox row (inside
// complete_webhook_notification_v1's own transaction) — a row that did not
// exist yet when the FIRST claim call ran, so it would never be seen or
// sent without a second claim pass. Always runs exactly once more after
// the main pass, bounded and deterministic (no unbounded loop): on the
// overwhelmingly common path this second claim simply returns nothing.
async function claimAndProcessNotifications(args) {
  const firstPassOk = await claimAndProcessOnce(args);
  if (firstPassOk === null) return false;

  const secondPassOk = await claimAndProcessOnce(args);
  if (secondPassOk === null) return false;

  return firstPassOk && secondPassOk;
}

const KNOWN_RESULTS = new Set(["locked", "failed", "already_processed", "duplicate_payment_conflict"]);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  let event;
  try {
    const buf = await buffer(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    return res.status(400).send("Webhook Error");
  }

  try {
    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({ ok: true });
    }

    const session = event.data.object;

    if (session?.payment_status !== "paid") {
      console.info("[webhook] session_not_paid", "event_ref =", maskId(event.id));
      return res.status(200).json({ ok: true });
    }

    const metadataOrderId = session?.metadata?.order_id || null;
    const clientReferenceId = session?.client_reference_id || null;

    const resolved = await resolveOrderId({ supabase, metadataOrderId, clientReferenceId });

    if (resolved.status === RESULT.MISSING) {
      console.info("[webhook] order_id_missing", "event_ref =", maskId(event.id), "session_ref =", maskId(session?.id));
      return res.status(200).json({ ok: true });
    }

    if (resolved.status === RESULT.UNRESOLVABLE_CONFLICT) {
      console.error(
        "[webhook][SECURITY] order_id_conflict_unresolvable",
        "event_ref =",
        maskId(event.id),
        "session_ref =",
        maskId(session?.id)
      );
      return res.status(500).json({ error: "order_id_conflict" });
    }

    const orderId = resolved.orderId;
    const idSourceConflict = resolved.status === RESULT.RESOLVED_CONFLICT;

    const { data: rpcResult, error: rpcError } = await supabase.rpc("process_checkout_payment_v1", {
      p_order_id: orderId,
      p_stripe_session_id: session.id,
      p_amount: session.amount_total,
      p_currency: session.currency,
      p_id_source_conflict: idSourceConflict,
    });

    if (rpcError) {
      console.error("[webhook] core_rpc_failed", "session_ref =", maskId(session.id));
      return res.status(500).json({ error: "processing_failed" });
    }

    const {
      result,
      reason,
      inventory_status: inventoryStatus,
      existing_order_id: existingOrderId,
    } = rpcResult || {};

    if (!KNOWN_RESULTS.has(result)) {
      console.error("[webhook] core_rpc_unexpected_result");
      return res.status(500).json({ error: "unexpected_rpc_result" });
    }

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select(
        `order_id, start_date, end_date, car_model_id, driver_lang, duration, email, name, phone,
         wechat, total_price, deposit_amount, balance_due, payment_status, inventory_status`
      )
      .eq("order_id", orderId)
      .single();

    if (orderErr || !order) {
      console.error("[webhook] order_lookup_failed");
      return res.status(500).json({ error: "order_lookup_failed" });
    }

    const notificationsOk = await claimAndProcessNotifications({
      orderId,
      sessionId: session.id,
      order,
      reason,
      existingOrderId,
    });

    if (!notificationsOk) {
      return res.status(500).json({ error: "notification_delivery_failed" });
    }

    return res.status(200).json({ ok: true, result });
  } catch (e) {
    console.error("[webhook] unhandled_exception");
    return res.status(500).json({ error: "internal_error" });
  }
}
