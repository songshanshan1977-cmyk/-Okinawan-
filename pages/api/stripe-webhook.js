// pages/api/stripe-webhook.js

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } };

// Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2022-11-15",
});

// Webhook secret
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Supabase（⚠️ 必须是 service_role）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 读取 raw body
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
    /**
     * ✅ 核心：支付真正成功
     */
    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object;

      let orderId = intent.metadata?.order_id || null;
      let carModelId = intent.metadata?.car_model_id || null;

      /**
       * 🔑 关键补丁：
       * Stripe Checkout 的 metadata 实际在 charge.metadata 上
       */
      if (!orderId && intent.latest_charge) {
        const charge = await stripe.charges.retrieve(intent.latest_charge);

        if (charge?.metadata) {
          orderId = charge.metadata.order_id || orderId;
          carModelId = charge.metadata.car_model_id || carModelId;
        }
      }

      if (!orderId) {
        console.warn(
          "⚠️ payment_intent.succeeded 但未找到 order_id，跳过写入 payments"
        );
        return res.json({ received: true });
      }

      console.log("💰 支付成功，order_id =", orderId);

      // 1️⃣ 更新 orders 表
      const { error: orderError } = await supabase
        .from("orders")
        .update({
          payment_status: "paid",
          paid_at: new Date().toISOString(),
        })
        .eq("order_id", orderId);

      if (orderError) {
        console.error("❌ 更新 orders 失败:", orderError);
        throw orderError;
      }

      // 2️⃣ 写入 payments 表
      const { error: paymentError } = await supabase.from("payments").insert([
        {
          order_id: orderId,
          stripe_session: intent.id, // payment_intent id
          amount: intent.amount_received,
          currency: intent.currency,
          car_model_id: carModelId,
          paid: true,
        },
      ]);

      if (paymentError) {
        console.error("❌ 写入 payments 失败:", paymentError);
        throw paymentError;
      }

      console.log("✅ payments 写入成功:", orderId);
    }

    /**
     * （可选）checkout.session.completed 仅记录日志
     */
    if (event.type === "checkout.session.completed") {
      console.log("📦 Checkout 完成:", event.data.object.id);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Webhook 处理异常:", err);
    return res.status(500).send("Internal Server Error");
  }
}


