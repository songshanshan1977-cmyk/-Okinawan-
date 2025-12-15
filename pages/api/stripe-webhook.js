// pages/api/stripe-webhook.js

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: { bodyParser: false },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2022-11-15",
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

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
     * ✅ 核心：支付成功 → 写 payments → 更新 orders → 扣库存
     */
    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object;
      const metadata = intent.metadata || {};

      const orderId = metadata.order_id;
      const carModelId = metadata.car_model_id;
      const serviceDate = metadata.service_date; // ⚠️ 必须是 YYYY-MM-DD

      if (!orderId || !carModelId || !serviceDate) {
        console.warn("⚠️ 缺少必要 metadata，跳过处理", {
          orderId,
          carModelId,
          serviceDate,
        });
        return res.json({ received: true });
      }

      // 🚧 防止 webhook 重复执行：先查 payments
      const { data: existingPayment } = await supabase
        .from("payments")
        .select("id")
        .eq("stripe_session_id", intent.id)
        .maybeSingle();

      if (existingPayment) {
        console.log("🔁 已处理过该支付，跳过:", intent.id);
        return res.json({ received: true });
      }

      console.log("💰 支付成功，开始处理订单 & 库存:", orderId);

      // 1️⃣ 更新 orders
      await supabase
        .from("orders")
        .update({
          payment_status: "paid",
          paid_at: new Date().toISOString(),
        })
        .eq("order_id", orderId);

      // 2️⃣ 写 payments
      await supabase.from("payments").insert([
        {
          order_id: orderId,
          stripe_session_id: intent.id,
          amount: intent.amount_received,
          currency: intent.currency,
          car_model_id: carModelId,
          paid: true,
        },
      ]);

      // 3️⃣ 扣库存（inventory）
      const { data: inventoryRow, error: inventoryError } = await supabase
        .from("inventory")
        .select("id, stock")
        .eq("car_model_id", carModelId)
        .eq("date", serviceDate)
        .single();

      if (inventoryError || !inventoryRow) {
        throw new Error("❌ 未找到对应库存记录");
      }

      if (inventoryRow.stock <= 0) {
        throw new Error("❌ 库存不足，无法扣减");
      }

      await supabase
        .from("inventory")
        .update({ stock: inventoryRow.stock - 1 })
        .eq("id", inventoryRow.id);

      console.log("📉 库存已扣减:", {
        carModelId,
        serviceDate,
        before: inventoryRow.stock,
        after: inventoryRow.stock - 1,
      });
    }

    /**
     * （可选）仅日志
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

