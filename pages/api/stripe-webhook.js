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
    // =========================
    // 主入口：checkout.session.completed
    // =========================
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // 兼容两种 key：order_id / orderId（避免前端写错导致查不到）
      const orderId = session.metadata?.order_id || session.metadata?.orderId;

      console.log("🧾 webhook received session:", session.id, "orderId:", orderId);

      if (!orderId) {
        console.warn("⚠️ checkout.session.completed 但 metadata 没有 order_id/orderId");
        return res.json({ received: true });
      }

      // 1) 读取订单（允许查不到，但不能崩）
      const { data: order, error: orderErr } = await supabase
        .from("orders")
        .select("order_id, status, car_model_id, date, inventory_locked")
        .eq("order_id", orderId)
        .maybeSingle();

      if (orderErr) {
        console.error("❌ 读取订单 SQL 错误:", orderErr);
        return res.status(500).send("Order query failed");
      }

      if (!order) {
        console.error("❌ 订单不存在（orders 没有这条 order_id）:", orderId);
        // 不要抛错，让 Stripe 不要无限重试把你刷爆
        return res.json({ received: true, order_found: false });
      }

      console.log("🧾 order found:", {
        order_id: order.order_id,
        status: order.status,
        inventory_locked: order.inventory_locked,
      });

      // 2) A1：更新订单 paid + 写 payments（幂等：先看是否已有 payment）
      //    注意：你的 payments 表没有 status 字段
      const { data: existingPay, error: existErr } = await supabase
        .from("payments")
        .select("id")
        .eq("order_id", orderId)
        .maybeSingle();

      if (existErr) {
        console.error("❌ 查询 payments 是否存在失败:", existErr);
      }

      // 确保拿到金额：优先 amount_total，拿不到就去取 PaymentIntent
      let amount = session.amount_total ?? null;
      let currency = session.currency ?? null;

      try {
        if ((!amount || !currency) && session.payment_intent) {
          const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
          amount = amount || pi.amount_received || pi.amount || null;
          currency = currency || pi.currency || null;
        }
      } catch (e) {
        console.error("❌ 读取 PaymentIntent 失败:", e?.message || e);
      }

      if (order.status !== "paid") {
        const { error: updErr } = await supabase
          .from("orders")
          .update({ status: "paid", paid_at: new Date().toISOString() })
          .eq("order_id", orderId);

        if (updErr) console.error("❌ orders 更新 paid 失败:", updErr);
        else console.log("✅ A1 orders -> paid:", orderId);
      } else {
        console.log("🔁 A1：orders 已经 paid，跳过更新:", orderId);
      }

      if (!existingPay) {
        const { error: payErr } = await supabase.from("payments").insert({
          order_id: orderId,
          stripe_session_id: session.id,
          amount: amount,       // int4
          currency: currency,   // text
        });

        if (payErr) console.error("❌ payments insert 失败:", payErr);
        else console.log("✅ A1 payments 写入成功:", orderId);
      } else {
        console.log("🔁 A1：payments 已存在，跳过写入:", orderId);
      }

      // 3) A2：库存锁定（幂等）
      if (order.inventory_locked !== true) {
        const { error: rpcErr } = await supabase.rpc("increment_locked_qty", {
          p_date: order.date,
          p_car_model_id: order.car_model_id,
        });

        if (rpcErr) console.error("❌ A2 RPC increment_locked_qty 失败:", rpcErr);
        else console.log("✅ A2 locked_qty +1:", orderId);

        const { error: lockErr } = await supabase
          .from("orders")
          .update({ inventory_locked: true })
          .eq("order_id", orderId);

        if (lockErr) console.error("❌ A2 orders.inventory_locked 更新失败:", lockErr);
        else console.log("✅ A2 orders.inventory_locked = true:", orderId);
      } else {
        console.log("🔁 A2：inventory_locked 已 true，跳过:", orderId);
      }
    }

    // 你原有 expired 逻辑保留（按你之前写法）
    if (event.type === "checkout.session.expired") {
      const session = event.data.object;
      const orderId = session.metadata?.order_id || session.metadata?.orderId || null;

      if (orderId) {
        const { data: order } = await supabase
          .from("orders")
          .select("car_model_id, date")
          .eq("order_id", orderId)
          .maybeSingle();

        if (order) {
          await supabase.rpc("release_inventory_lock", {
            p_car_model_id: order.car_model_id,
            p_date: order.date,
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

