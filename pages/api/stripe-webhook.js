// pages/api/stripe-webhook.js
//
// v1 fail-safe rewrite (sandbox/webhook-fail-safe-v1). All business-content
// writes (orders/payments/inventory) happen inside the single atomic
// process_checkout_payment_v1 RPC (see supabase/migrations/
// 20260722120000_webhook_fail_safe_v1.sql) — this handler's job is limited
// to: verify the Stripe signature, filter/validate the event, resolve which
// order it refers to, call the RPC, and dispatch the correct email template
// based on the RPC's result. It never marks an order "paid" on its own,
// and no exception path returns 200 — only genuinely inert cases
// (unrelated event, unpaid session, unresolvable order_id) do.

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

const { resolveOrderId, RESULT } = require("../../lib/webhook/resolveOrderId");
const {
  buildCustomerSuccessEmail,
  buildOpsSuccessEmail,
  buildCustomerPendingEmail,
  buildOpsUrgentEmail,
} = require("../../lib/webhook/emailTemplates");

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

// Claim-then-send: same per-order boolean-flag idempotency pattern as the
// pre-v1 webhook. Returns false only when THIS call attempted a real send
// and it failed — the caller then makes the whole webhook return 5xx so
// Stripe redelivers and another attempt happens. The claim flag is rolled
// back to false on failure so the retry isn't blocked by its own claim.
async function claimAndSend({ order, flagColumn, to, mail }) {
  if (!to) return true; // nothing to send to is not a delivery failure
  if (order[flagColumn]) return true; // already sent

  const { data, error } = await supabase
    .from("orders")
    .update({ [flagColumn]: true })
    .eq("order_id", order.order_id)
    .eq(flagColumn, false)
    .select("order_id");

  if (error) return false;
  if (!data || data.length === 0) return true; // lost the claim to a concurrent delivery

  try {
    await resend.emails.send({ from: RESEND_FROM, to, subject: mail.subject, html: mail.html });
    return true;
  } catch (err) {
    await supabase.from("orders").update({ [flagColumn]: false }).eq("order_id", order.order_id);
    return false;
  }
}

async function sendEmailsForOutcome({ order, result, inventoryStatus, reason, stripeSessionId }) {
  // "locked" always gets the success template. "already_processed" replays
  // whatever the ORIGINAL processing actually decided (via inventoryStatus).
  // "failed" and "duplicate_payment_conflict" ALWAYS get the pending/urgent
  // template, even if inventoryStatus happens to read "locked" (that would
  // mean a different, earlier session already succeeded for this order —
  // this second/conflicting session still needs human review, not a second
  // "booking confirmed" email).
  const useSuccessTemplate =
    result === "locked" || (result === "already_processed" && inventoryStatus === "locked");

  if (useSuccessTemplate) {
    const okCustomer = await claimAndSend({
      order,
      flagColumn: "email_customer_sent",
      to: order.email,
      mail: buildCustomerSuccessEmail(order),
    });
    const okOps = await claimAndSend({
      order,
      flagColumn: "email_ops_sent",
      to: OPS_EMAIL_TO,
      mail: buildOpsSuccessEmail(order),
    });
    return okCustomer && okOps;
  }

  // failed / duplicate_payment_conflict: money received, needs human review.
  const okCustomer = await claimAndSend({
    order,
    flagColumn: "email_customer_sent",
    to: order.email,
    mail: buildCustomerPendingEmail(order),
  });
  const okOps = await claimAndSend({
    order,
    flagColumn: "email_ops_sent",
    to: OPS_EMAIL_TO,
    mail: buildOpsUrgentEmail(order, reason, stripeSessionId),
  });
  return okCustomer && okOps;
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
        event.id
      );
      return res.status(200).json({ ok: true });
    }

    const metadataOrderId = session?.metadata?.order_id || null;
    const clientReferenceId = session?.client_reference_id || null;

    const resolved = await resolveOrderId({ supabase, metadataOrderId, clientReferenceId });

    if (resolved.status === RESULT.MISSING) {
      console.info("[webhook] order_id missing, event.id =", event.id, "session.id =", session?.id);
      return res.status(200).json({ ok: true });
    }

    if (resolved.status === RESULT.UNRESOLVABLE_CONFLICT) {
      console.error(
        "[webhook][SECURITY] unresolvable order_id conflict, event.id =",
        event.id,
        "session.id =",
        session?.id
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
      console.error("[webhook] process_checkout_payment_v1 failed:", rpcError.message);
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
         wechat, total_price, deposit_amount, balance_due, email_customer_sent, email_ops_sent`
      )
      .eq("order_id", orderId)
      .single();

    if (orderErr || !order) {
      console.error("[webhook] post-RPC order lookup failed for email dispatch");
      return res.status(500).json({ error: "order_lookup_failed" });
    }

    const emailsOk = await sendEmailsForOutcome({
      order,
      result,
      inventoryStatus: inventoryStatus || (result === "locked" ? "locked" : "failed"),
      reason,
      stripeSessionId: session.id,
    });

    if (!emailsOk) {
      return res.status(500).json({ error: "email_delivery_failed" });
    }

    return res.status(200).json({ ok: true, result });
  } catch (e) {
    console.error("[webhook] unhandled exception (detail withheld from response)");
    return res.status(500).json({ error: "internal_error" });
  }
}
