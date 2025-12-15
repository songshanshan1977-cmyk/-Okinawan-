// pages/api/stripe-webhook.js

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

// ❗必须关闭 bodyParser（Stripe 原始签名校验）
export const config = {
  api: { bodyParser: false },
};

// Stripe 初始化
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2022-11-15",
});

// Webhook Secret
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Supabase（service role）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 读取原始 body
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
      const metadata = intent.metadata || {};

      const orderId = metadata.order_id;
      const carModelId = metadata.car_model_id || null;

      if (!orderId) {
        console.warn("⚠️ payment_intent.succeeded 但没有 order_id");
        return res.json({ received: true });
      }

      console.log("💰 支付成功:", {
        orderId,
        intentId: intent.id,
      });

      /**
       * 1️⃣ 更新 orders（保持你原来的逻辑）
       */
      await supabase
        .from("orders")
        .update({
          payment_status: "paid",
          paid_at: new Date().toISOString(),
        })
        .eq("order_id", orderId);

      /**
       * 2️⃣ 写 payments（✅ 幂等防重复，关键修复点）
       */
      const { data: existingPayment, error: selectError } = await supabase
        .from("payments")
        .select("id")
        .eq("stripe_session", intent.id)
        .maybeSingle();

      if (selectError) {
        console.error("❌ 查询 payments 失败:", selectError);
        throw selectError;
      }

      if (!existingPayment) {
        await supabase.from("payments").insert([
          {
            order_id: orderId,
            stripe_session: intent.id,
            amount: intent.amount_received,
            currency: intent.currency,
            car_model_id: carModelId,
            paid: true,
          },
        ]);

        console.log("✅ payments 写入成功:", intent.id);
      } else {
        console.log("⚠️ payments 已存在，跳过写入:", intent.id);
      }
    }

    /**
     * （可选）checkout.session.completed —— 只记录日志
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

