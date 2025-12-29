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
     * ==================================================
     * A1 + A2 主入口（唯一）：checkout.session.completed
     * ==================================================
     */
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const orderId = session.metadata?.order_id;

      if (!orderId) {
        console.warn("⚠️ checkout.session.completed 但没有 order_id");
        return res.json({ received: true });
      }

      /**
       * 1️⃣ 读取订单
       */
      const { data: order, error: orderErr } = await supabase
        .from("orders")
        .select(
          "id, order_id, status, car_model_id, start_date, inventory_locked"
        )
        .eq("order_id", orderId)
        .single();

      if (orderErr || !order) {
        console.error("❌ 订单不存在:", orderId, orderErr);
        return res.json({ received: true });
      }

      /**
       * ======================
       * A1：标记订单已支付 + 写 payments
       * ======================
       */
      if (order.status !== "paid") {
        // 1️⃣ 更新 orders
        await supabase
          .from("orders")
          .update({
            status: "paid",
            paid_at: new Date().toISOString(),
          })
          .eq("order_id", orderId);

        // 2️⃣ 写入 payments（⚠️ 关键修复点）
        await supabase.from("payments").insert({
          order_id: orderId,
          stripe_session_id: session.id,
          amount: session.amount_total,
          currency: session.currency,
          car_model_id: order.car_model_id, // ✅ 必填：解决 NOT NULL
          paid: true,                       // ✅ 明确标记
        });

        console.log("✅ A1 完成：订单已 paid + payments 写入", orderId);
      }

      /**
       * ======================
       * A2：库存扣减（幂等）
       * ======================
       */
      if (order.inventory_locked !== true) {
        await supabase.rpc("increment_locked_qty", {
          p_date: order.start_date,
          p_car_model_id: order.car_model_id,
        });

        await supabase
          .from("orders")
          .update({ inventory_locked: true })
          .eq("order_id", orderId);

        console.log("✅ A2 完成：库存 locked_qty +1", orderId);
      } else {
        console.log("🔁 A2 幂等命中，已跳过库存扣减", orderId);
      }
    }

    /**
     * =========================
     * checkout.session.expired
     * =========================
     */
    if (event.type === "checkout.session.expired") {
      const session = event.data.object;
      const orderId = session.metadata?.order_id || null;

      if (orderId) {
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
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Webhook 处理异常:", err);
    return res.status(500).send("Internal Server Error");
  }
}

