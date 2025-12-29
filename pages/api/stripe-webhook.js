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

  // ==================================================
  // 只处理 checkout.session.completed
  // ==================================================
  if (event.type !== "checkout.session.completed") {
    return res.json({ received: true });
  }

  const session = event.data.object;
  const orderId = session.metadata?.order_id;

  if (!orderId) {
    console.warn("⚠️ checkout.session.completed 缺少 order_id");
    return res.json({ received: true });
  }

  // =========================
  // 1️⃣ 读取订单（安全）
  // =========================
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("order_id, status, car_model_id, date, inventory_locked")
    .eq("order_id", orderId)
    .maybeSingle();

  if (orderErr || !order) {
    console.error("❌ 订单不存在:", orderId, orderErr);
    return res.json({ received: true });
  }

  // =========================
  // A1：订单 paid + payments 写入
  // =========================
  if (order.status !== "paid") {
    const { error: orderUpdateErr } = await supabase
      .from("orders")
      .update({
        status: "paid",
        paid_at: new Date().toISOString(),
      })
      .eq("order_id", orderId);

    if (orderUpdateErr) {
      console.error("❌ orders 更新失败:", orderUpdateErr);
    }

    const { error: paymentErr } = await supabase
      .from("payments")
      .insert({
        order_id: orderId,
        stripe_session_id: session.id,
        amount: session.amount_total,
        currency: session.currency,
      });

    if (paymentErr) {
      console.error("❌ payments 写入失败:", paymentErr);
    } else {
      console.log("✅ payments 写入成功:", orderId);
    }
  } else {
    console.log("🔁 A1 幂等命中，已 paid:", orderId);
  }

  // =========================
  // A2：库存锁（不影响 A1）
  // =========================
  if (!order.inventory_locked) {
    try {
      const { error: lockErr } = await supabase.rpc(
        "increment_locked_qty",
        {
          p_date: order.date,
          p_car_model_id: order.car_model_id,
        }
      );

      if (lockErr) {
        console.error("❌ A2 锁库存失败:", lockErr);
      } else {
        await supabase
          .from("orders")
          .update({ inventory_locked: true })
          .eq("order_id", orderId);

        console.log("✅ A2 库存锁定成功:", orderId);
      }
    } catch (e) {
      console.error("❌ A2 异常:", e);
    }
  } else {
    console.log("🔁 A2 幂等命中，库存已锁:", orderId);
  }

  return res.json({ received: true });
}
