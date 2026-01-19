// pages/api/stripe-webhook.js

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

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

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  console.log("stripe-webhook version = 2026-01-19-v3-FROM-FIX");

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  let event;

  try {
    const buf = await buffer(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed.", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({ ok: true });
    }

    const session = event.data.object;
    const orderId =
      session?.metadata?.order_id ||
      session?.metadata?.orderId ||
      session?.client_reference_id;

    if (!orderId) {
      return res.status(200).json({ ok: true, skipped: "missing_orderId" });
    }

    const { data: order } = await supabase
      .from("orders")
      .select(
        "order_id,start_date,car_model_id,driver_lang,duration,name,phone,email"
      )
      .eq("order_id", orderId)
      .single();

    if (!order) {
      return res.status(200).json({ ok: true, skipped: "order_not_found" });
    }

    const FROM = process.env.RESEND_FROM;

    // === 客人确认邮件 ===
    if (order.email) {
      await resend.emails.send({
        from: FROM,
        to: order.email,
        subject: `HonestOki 预约确认｜${order.order_id}`,
        html: `<p>您的订单已确认：${order.order_id}</p>`,
      });
    }

    // === 运营新订单提醒 ===
    await resend.emails.send({
      from: FROM,
      to: "songshanshan1977@gmail.com",
      subject: `【新订单】${order.order_id}｜${order.start_date}`,
      html: `<p>新订单 ${order.order_id}</p>`,
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("webhook error:", e);
    return res.status(200).json({ ok: true });
  }
}

