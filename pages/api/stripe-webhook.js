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

  // 只处理 checkout.session.completed
  if (event.type !== "checkout.session.completed") {
    return res.json({ received: true });
  }

  const session = event.data.object;
  const orderId = session.metadata?.order_id;

  if (!orderId) {
    console.warn("⚠️ 缺少 order_id");
    return res.json({ received: true });
  }

  // =========================
  // 1️⃣ 正确读取 orders
  // =========================
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select(
      "order_id, status, car_model_id, start_date, inventory_locked"
    )
    .eq("order_id", orderId)
    .maybeSingle();

  if (orderErr || !order) {
    console.error("❌ 订单读取失败:", orderId, orderErr);
    return res.json({ received: true });
  }

  // =========================
  // A1：订单 paid + payments 写入
  // =========================
  if (order.status !== "paid") {
    await supabase
      .from("orders")
      .update({
        status: "paid",
        paid_at: new Date().toISOString(),
      })
      .eq("order_id", orderId);

    const { error: payErr } = await supabase
      .from("payments")
      .insert({
        order_id: orderId,
        stripe_session_id: session.id,
        amount: session.amount_total,
        currency: session.currency,
      });

    if (payErr) {
      console.error("❌ payments 写入失败:", payErr);
    } else {
      console.log("✅ payments 写入成功:", orderId);
    }
  } else {
    console.log("🔁 已是 paid，跳过 A1");
  }

  // =========================
  // A2：库存锁定（用 start_date）
  // =========================
  if (!order.inventory_locked) {
    const { error: lockErr } = await supabase.rpc(
      "increment_locked_qty",
      {
        p_date: order.start_date,
        p_car_model_id: order.car_model_id,
      }
    );

    if (!lockErr) {
      await supabase
        .from("orders")
        .update({ inventory_locked: true })
        .eq("order_id", orderId);

      console.log("✅ A2 库存锁定成功:", orderId);
    } else {
      console.error("❌ A2 锁库存失败:", lockErr);
    }
  }

  return res.json({ received: true });
}
