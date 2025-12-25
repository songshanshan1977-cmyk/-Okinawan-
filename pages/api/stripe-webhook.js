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
     * =========================
     * 1️⃣ 支付成功 → 确认库存
     * =========================
     */
    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object;

      const orderId = intent.metadata?.order_id || null;
      if (!orderId) {
        console.warn("⚠️ payment_intent.succeeded 但没有 order_id");
        return res.json({ received: true });
      }

      // 读取订单（用于幂等）
      const { data: order, error } = await supabase
        .from("orders")
        .select("car_model_id, start_date, inventory_confirmed_at")
        .eq("order_id", orderId)
        .maybeSingle();

      if (error || !order) {
        console.error("❌ 读取订单失败:", error);
        throw error;
      }

      // ⭐ 幂等：只确认一次库存
      if (!order.inventory_confirmed_at) {
        // ✅ 确认库存（RPC）
        await supabase.rpc("confirm_inventory", {
          p_car_model_id: order.car_model_id,
          p_date: order.start_date,
        });

        // 标记已确认库存
        await supabase
          .from("orders")
          .update({
            payment_status: "paid",
            paid_at: new Date().toISOString(),
            inventory_confirmed_at: new Date().toISOString(),
          })
          .eq("order_id", orderId);

        console.log("✅ 支付成功，库存已确认:", orderId);
      } else {
        console.log("🔁 重复 webhook，已跳过库存确认:", orderId);
      }
    }

    /**
     * =========================
     * 2️⃣ 支付失败 → 释放锁
     * =========================
     */
    if (event.type === "payment_intent.payment_failed") {
      const intent = event.data.object;
      const orderId = intent.metadata?.order_id || null;

      if (!orderId) {
        return res.json({ received: true });
      }

      const { data: order } = await supabase
        .from("orders")
        .select("car_model_id, start_date")
        .eq("order_id", orderId)
        .maybeSingle();

      if (order) {
        await supabase.rpc("release_inventory_lock", {
          p_car_model_id: order.car_model_id,
          p_date: order.start_date,
        });

        console.log("↩️ 支付失败，库存锁已释放:", orderId);
      }
    }

    /**
     * =========================
     * 3️⃣ 会话过期 → 释放锁
     * =========================
     */
    if (event.type === "checkout.session.expired") {
      const session = event.data.object;
      const orderId = session.metadata?.order_id || null;

      if (!orderId) {
        return res.json({ received: true });
      }

      const { data: order } = await supabase
        .from("orders")
        .select("car_model_id, start_date")
        .eq("order_id", orderId)
        .maybeSingle();

      if (order) {
        await supabase.rpc("release_inventory_lock", {
          p_car_model_id: order.car_model_id,
          p_date: order.start_date,
        });

        console.log("⏰ 会话过期，库存锁已释放:", orderId);
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Webhook 处理异常:", err);
    return res.status(500).send("Internal Server Error");
  }
}


