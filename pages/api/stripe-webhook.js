// pages/api/stripe-webhook.js

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } };

// Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2022-11-15",
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Supabase（必须用 service role）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 读取 raw body（Stripe webhook 必须）
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
     * 主入口：checkout.session.completed
     * ==================================================
     */
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // 兼容两种 metadata 写法
      const orderId =
        session.metadata?.order_id || session.metadata?.orderId || null;

      console.log("🧾 Webhook 命中 checkout.session.completed", {
        session_id: session.id,
        orderId,
      });

      if (!orderId) {
        console.warn("⚠️ metadata 中没有 order_id，直接跳过");
        return res.json({ received: true });
      }

      /**
       * 1️⃣ 读取订单（⚠️ 关键：字段名必须和真实表一致）
       */
      const { data: order, error: orderErr } = await supabase
        .from("orders")
        .select(
          "order_id, status, car_model_id, start_date, inventory_locked"
        )
        .eq("order_id", orderId)
        .maybeSingle();

      if (orderErr) {
        console.error("❌ 读取订单 SQL 错误:", orderErr);
        return res.status(500).send("Order query failed");
      }

      if (!order) {
        console.error("❌ 订单不存在，order_id =", orderId);
        // 不抛错，避免 Stripe 无限重试
        return res.json({ received: true, order_found: false });
      }

      console.log("🧾 订单读取成功:", {
        order_id: order.order_id,
        status: order.status,
        inventory_locked: order.inventory_locked,
      });

      /**
       * 2️⃣ A1：订单 paid + payments 写入（幂等）
       */

      // 查 payments 是否已存在（避免重复写）
      const { data: existingPayment, error: existErr } = await supabase
        .from("payments")
        .select("id")
        .eq("order_id", orderId)
        .maybeSingle();

      if (existErr) {
        console.error("❌ 查询 payments 是否存在失败:", existErr);
      }

      // 从 PaymentIntent 取真实金额（最稳）
      let amount = null;
      let currency = null;

      try {
        if (session.payment_intent) {
          const pi = await stripe.paymentIntents.retrieve(
            session.payment_intent
          );
          amount = pi.amount_received ?? pi.amount ?? null;
          currency = pi.currency ?? null;
        }
      } catch (e) {
        console.error("❌ 读取 PaymentIntent 失败:", e);
      }

      // 更新订单状态（即使重复也安全）
      if (order.status !== "paid") {
        const { error: updErr } = await supabase
          .from("orders")
          .update({
            status: "paid",
            paid_at: new Date().toISOString(),
          })
          .eq("order_id", orderId);

        if (updErr) {
          console.error("❌ orders 更新 paid 失败:", updErr);
        } else {
          console.log("✅ A1 orders.status = paid");
        }
      } else {
        console.log("🔁 A1 orders 已是 paid，跳过更新");
      }

      // 写 payments（只写一次）
      if (!existingPayment) {
        const { error: payErr } = await supabase.from("payments").insert({
          order_id: orderId,
          stripe_session_id: session.id,
          amount: amount,
          currency: currency,
        });

        if (payErr) {
          console.error("❌ payments insert 失败:", payErr);
        } else {
          console.log("✅ A1 payments 写入成功");
        }
      } else {
        console.log("🔁 A1 payments 已存在，跳过写入");
      }

      /**
       * 3️⃣ A2：库存锁定（幂等）
       */
      if (order.inventory_locked !== true) {
        const { error: rpcErr } = await supabase.rpc(
          "increment_locked_qty",
          {
            p_date: order.start_date, // ⚠️ 必须是 start_date
            p_car_model_id: order.car_model_id,
          }
        );

        if (rpcErr) {
          console.error("❌ A2 increment_locked_qty 失败:", rpcErr);
        } else {
          console.log("✅ A2 locked_qty +1");
        }

        const { error: lockErr } = await supabase
          .from("orders")
          .update({ inventory_locked: true })
          .eq("order_id", orderId);

        if (lockErr) {
          console.error("❌ A2 inventory_locked 更新失败:", lockErr);
        } else {
          console.log("✅ A2 inventory_locked = true");
        }
      } else {
        console.log("🔁 A2 inventory 已锁，跳过");
      }
    }

    /**
     * ==================================================
     * checkout.session.expired（保留）
     * ==================================================
     */
    if (event.type === "checkout.session.expired") {
      const session = event.data.object;
      const orderId =
        session.metadata?.order_id || session.metadata?.orderId || null;

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

