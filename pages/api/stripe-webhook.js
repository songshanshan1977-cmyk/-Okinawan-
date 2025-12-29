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

  if (event.type !== "checkout.session.completed") {
    return res.json({ received: true });
  }

  const session = event.data.object;
  const orderId = session.metadata?.order_id;

  if (!orderId) {
    console.warn("⚠️ 缺少 order_id");
    return res.json({ received: true });
  }

  /** ======================
   * 1️⃣ 读取订单
   * ====================== */
  const { data: order } = await supabase
    .from("orders")
    .select(
      "order_id, status, car_model_id, start_date, inventory_locked"
    )
    .eq("order_id", orderId)
    .maybeSingle();

  if (!order) {
    console.error("❌ 订单不存在:", orderId);
    return res.json({ received: true });
  }

  /** ======================
   * A1：支付成功 → 写 payments
   * ====================== */
  if (order.status !== "paid") {
    await supabase
      .from("orders")
      .update({
        status: "paid",
        paid_at: new Date().toISOString(),
      })
      .eq("order_id", orderId);

    await supabase.from("payments").insert({
      order_id: orderId,
      stripe_session_id: session.id,
      amount: session.amount_total,
      currency: session.currency,
    });

    console.log("✅ A1：订单已支付 & payments 写入");
  }

  /** ======================
   * A2：库存锁定（加防守）
   * ====================== */
  if (order.inventory_locked === true) {
    console.log("🔁 A2 已锁过库存，跳过");
    return res.json({ received: true });
  }

  // 读取 inventory 当前状态
  const { data: inv } = await supabase
    .from("inventory")
    .select("id, total_qty, locked_qty")
    .eq("date", order.start_date)
    .eq("car_model_id", order.car_model_id)
    .maybeSingle();

  if (!inv) {
    console.error("❌ inventory 不存在");
    return res.json({ received: true });
  }

  if (inv.locked_qty >= inv.total_qty) {
    console.warn(
      "⚠️ A2 跳过：库存已满",
      inv.locked_qty,
      "/",
      inv.total_qty
    );
    return res.json({ received: true });
  }

  // 真正锁库存
  const { error: lockErr } = await supabase.rpc(
    "increment_locked_qty",
    {
      p_date: order.start_date,
      p_car_model_id: order.car_model_id,
    }
  );

  if (lockErr) {
    console.error("❌ A2 锁库存失败:", lockErr);
    return res.json({ received: true });
  }

  await supabase
    .from("orders")
    .update({ inventory_locked: true })
    .eq("order_id", orderId);

  console.log("✅ A2：库存锁定成功");

  return res.json({ received: true });
}
