// pages/api/stripe-webhook.js
//
// v1 fail-safe rewrite (sandbox/webhook-fail-safe-v1), revised in the
// Codex Draft-PR-#2 blocking-fix round. All business-content writes
// (orders/payments/inventory/notification outbox) happen inside the
// single atomic process_checkout_payment_v1 RPC (see supabase/migrations/
// 20260722120000_webhook_fail_safe_v1.sql). This handler's job is limited
// to: verify the Stripe signature, filter/validate the event, resolve
// which order it refers to, call the RPC, then claim/send/complete every
// outstanding notification via the send_logs outbox (see
// 20260722130000_webhook_notification_outbox_v1.sql) — it never marks an
// order "paid" on its own, never decides email-sent state via the legacy
// per-order boolean email flags on orders (see B-03/B-04 in the round's
// completion report), and no exception path returns 200 — only genuinely
// inert cases (unrelated event, unpaid session, unresolvable order_id) do.
//
// B-05: no log line in this file may contain a complete Stripe Session ID,
// Event ID, PaymentIntent ID, or customer PII (email/phone/name) — always
// go through maskId() first.

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

const { resolveOrderId, RESULT } = require("../../lib/webhook/resolveOrderId");
const { buildNotificationContent } = require("../../lib/webhook/notificationContent");
const { maskId } = require("../../lib/webhook/maskId");

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

const RESEND_FROM =
  process.env.RESEND_FROM || "HonestOki <noreply@xn--okinawa-n14kh45a.com>";
const OPS_EMAIL_TO = process.env.NOTIFY_TO_EMAIL || "songshanshan1977@gmail.com";

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function safeTruncate(msg, max = 300) {
  const s = msg ? String(msg) : "unknown_error";
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

// B-03: the installed Resend SDK (3.5.0) response shape is
// `{ data: { id } | null, error: ErrorResponse | null }` — a resolved
// promise is NOT proof of delivery. All three of these must be treated as
// failures, not just a thrown/rejected promise:
//   - the promise rejects (network/SDK-level failure)
//   - it resolves with a non-null `error`
//   - it resolves with no `data` (or `data.id` missing) AND no `error`
//     either (defensive: an SDK/API contract violation should never be
//     silently treated as success)
async function sendViaResend({ to, mail }) {
  let response;
  try {
    response = await resend.emails.send({ from: RESEND_FROM, to, subject: mail.subject, html: mail.html });
  } catch (err) {
    return { ok: false, errorMessage: safeTruncate(err && err.message) };
  }

  const { data, error } = response || {};
  if (error) {
    return { ok: false, errorMessage: safeTruncate(error.message || JSON.stringify(error)) };
  }
  if (!data || !data.id) {
    return { ok: false, errorMessage: "resend_response_missing_message_id" };
  }
  return { ok: true, providerMessageId: data.id };
}

// B-04: claim every send_logs outbox row still owed for this
// (order_id, stripe_session_id) pair, send each one, and mark it
// sent/failed via complete_webhook_notification_v1 using the exact
// claim_token the claim handed out. Recovers correctly no matter where a
// PREVIOUS attempt died:
//   - died before claiming at all -> row is still 'pending', claimed fresh
//   - died between claim and calling Resend -> claim_expires_at lapses
//     (2 min lease), a later retry's claim picks the row back up
//   - died between Resend accepting the email and calling complete() ->
//     same recovery path (claim_expires_at lapses); THIS is the one
//     interruption window this round's design does not fully close, see
//     the completion report's Resend-idempotency-key limitation note —
//     the installed SDK exposes no per-call Idempotency-Key, so a retry
//     that re-claims after that exact crash point can send a second,
//     genuinely duplicate email. The outbox still guarantees no
//     *silent* loss and no *unbounded* retry storm (attempt_count is
//     tracked), which is the property this round's instructions required;
//     true no-duplicate delivery across that specific window needs either
//     an SDK upgrade or a different provider-side idempotency mechanism,
//     both out of scope this round.
async function claimAndProcessNotifications({ orderId, sessionId, order, reason }) {
  const { data: claimed, error: claimError } = await supabase.rpc("claim_webhook_notification_v1", {
    p_order_id: orderId,
    p_stripe_session_id: sessionId,
  });

  if (claimError) {
    console.error("[webhook] claim_webhook_notification_v1 failed:", claimError.message);
    return false;
  }

  const rows = claimed || [];
  let allOk = true;

  for (const row of rows) {
    const content = buildNotificationContent({
      notificationType: row.notification_type,
      order,
      reason,
      stripeSessionId: sessionId,
      opsEmailTo: OPS_EMAIL_TO,
    });

    if (!content || !content.to) {
      // Nothing sensible to deliver to (unknown notification_type, or the
      // order has no email on file for a customer-audience row) — not a
      // delivery failure. Complete it so it doesn't sit claimable forever.
      await supabase.rpc("complete_webhook_notification_v1", {
        p_dedupe_key: row.dedupe_key,
        p_claim_token: row.claim_token,
        p_success: true,
        p_provider_message_id: null,
        p_error_message: null,
      });
      continue;
    }

    const sendResult = await sendViaResend({ to: content.to, mail: content.mail });

    const { data: completeResult, error: completeError } = await supabase.rpc("complete_webhook_notification_v1", {
      p_dedupe_key: row.dedupe_key,
      p_claim_token: row.claim_token,
      p_success: sendResult.ok,
      p_provider_message_id: sendResult.ok ? sendResult.providerMessageId : null,
      p_error_message: sendResult.ok ? null : sendResult.errorMessage,
    });

    if (completeError) {
      console.error("[webhook] complete_webhook_notification_v1 failed:", completeError.message);
      allOk = false;
      continue;
    }

    if (completeResult && completeResult.ok === false) {
      // Lost the claim (already completed elsewhere, or expired and
      // reclaimed by a concurrent delivery) — not this call's failure.
      continue;
    }

    if (!sendResult.ok) {
      allOk = false;
    }
  }

  return allOk;
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
      console.info(
        "[webhook] session not paid, payment_status =",
        session?.payment_status,
        "event.id =",
        maskId(event.id)
      );
      return res.status(200).json({ ok: true });
    }

    const metadataOrderId = session?.metadata?.order_id || null;
    const clientReferenceId = session?.client_reference_id || null;

    const resolved = await resolveOrderId({ supabase, metadataOrderId, clientReferenceId });

    if (resolved.status === RESULT.MISSING) {
      console.info("[webhook] order_id missing, event.id =", maskId(event.id), "session.id =", maskId(session?.id));
      return res.status(200).json({ ok: true });
    }

    if (resolved.status === RESULT.UNRESOLVABLE_CONFLICT) {
      console.error(
        "[webhook][SECURITY] unresolvable order_id conflict, event.id =",
        maskId(event.id),
        "session.id =",
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
      console.error(
        "[webhook] process_checkout_payment_v1 failed, session.id =",
        maskId(session.id),
        "reason =",
        rpcError.message
      );
      return res.status(500).json({ error: "processing_failed" });
    }

    const { result, reason, inventory_status: inventoryStatus } = rpcResult || {};

    if (!KNOWN_RESULTS.has(result)) {
      console.error("[webhook] unexpected RPC result shape:", result);
      return res.status(500).json({ error: "unexpected_rpc_result" });
    }

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select(
        `order_id, start_date, end_date, car_model_id, driver_lang, duration, email, name, phone,
         wechat, total_price, deposit_amount, balance_due`
      )
      .eq("order_id", orderId)
      .single();

    if (orderErr || !order) {
      console.error("[webhook] post-RPC order lookup failed for notification dispatch");
      return res.status(500).json({ error: "order_lookup_failed" });
    }

    const notificationsOk = await claimAndProcessNotifications({
      orderId,
      sessionId: session.id,
      order,
      reason,
    });

    if (!notificationsOk) {
      return res.status(500).json({ error: "notification_delivery_failed" });
    }

    return res.status(200).json({ ok: true, result });
  } catch (e) {
    console.error("[webhook] unhandled exception (detail withheld from response)");
    return res.status(500).json({ error: "internal_error" });
  }
}
