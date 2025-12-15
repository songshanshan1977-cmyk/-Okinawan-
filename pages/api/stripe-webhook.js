// pages/api/stripe-webhook.js

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2022-11-15",
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const sig = req.headers["stripe-signature"];
  const buf = await buffer(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error("❌ Webhook 签名校验失败:", err.message);
    return res.status(400).send("Webhook Error");
  }

  try {
    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object;

      let orderId = intent.metadata?.order_id || null;
      let carModelId = intent.metadata?.car_model_id || null;

      // ✅ 兼容 metadata 在 charge 上的情况（你原本就写对了）
      if (!orderId && intent.latest_charge) {
        const charge = await stripe.charges.retrieve(intent.latest_charge);
        if (charge?.metadata) {
          orderId = charge.metadata.order_id || orderId;
          carModelId = charge.metadata.car_model_id || carModelId;
        }
      }

      if (!orderId) {
        console.warn("⚠️ payment_intent.succeeded 但没有 order_id");
        return res.json({ received: true });
      }

      // 1️⃣ 更新 orders（保持你原逻辑）
      await supabase
        .from("orders")
        .update({
          payment_status: "paid",
          paid_at: new Date().toISOString(),
        })
        .eq("order_id", orderId);

      // 2️⃣ ✅ 防重复：先查 payments
      const { data: existing } = await supabase
        .from("payments")
        .select("id")
        .eq("stripe_session_id", intent.id)
        .maybeSingle();

      if (!existing) {
        await supabase.from("payments").insert([
          {
            order_id: orderId,
            stripe_session_id: intent.id, // ✅ 正确字段名
            amount: intent.amount_received,
            currency: intent.currency,
            car_model_id: carModelId,
            paid: true,
          },
        ]);
      }
    }

    if (event.type === "checkout.session.completed") {
      console.log("📦 checkout 完成:", event.data.object.id);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Webhook 处理异常:", err);
    return res.status(500).send("Internal Server Error");
  }
}


