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

// 小工具：driver_lang 统一成 ZH / JP
function normalizeDriverLang(v) {
  const s = String(v || "").trim().toUpperCase();
  if (s === "ZH" || s === "JP") return s;
  // 兼容你历史可能写过 zh/jp
  if (s === "Z H" || s === "CH" || s === "CN") return "ZH";
  if (s === "J P" || s === "JA" || s === "JP") return "JP";
  return "ZH";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const sig = req.headers["stripe-signature"];
  if (!sig) return res.status(400).json({ error: "Missing stripe-signature" });

  let event;
  try {
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error("❌ Webhook signature verify failed:", err?.message || err);
    return res.status(400).json({ error: "Webhook signature verification failed" });
  }

  // ✅ 只处理：checkout.session.completed
  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({ received: true, ignored: event.type });
  }

  const session = event.data.object;

  // 你下单时写进去的 metadata.order_id（必须有）
  const orderId = session?.metadata?.order_id;
  if (!orderId) {
    console.error("❌ Missing metadata.order_id in session:", session?.id);
    return res.status(400).json({ error: "Missing metadata.order_id" });
  }

  try {
    // 1) 读取订单（拿 start_date/end_date/car_model_id/driver_lang 等）
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select(
        "order_id, payment_status, inventory_locked, car_model_id, start_date, end_date, driver_lang"
      )
      .eq("order_id", orderId)
      .single();

    if (orderErr || !order) {
      console.error("❌ Order not found:", orderId, orderErr);
      return res.status(500).json({ error: "Order not found in DB" });
    }

    // ✅ 幂等：如果已经锁过库存，就直接返回（防重复扣）
    if (order.inventory_locked === true) {
      console.log("✅ Inventory already locked, skip:", orderId);
      return res.status(200).json({ received: true, alreadyLocked: true });
    }

    const startDate = order.start_date;
    const endDate = order.end_date || order.start_date;
    const carModelId = order.car_model_id;
    const driverLang = normalizeDriverLang(order.driver_lang);

    if (!startDate || !carModelId) {
      console.error("❌ Order missing start_date/car_model_id:", orderId, order);
      return res.status(500).json({ error: "Order missing required fields" });
    }

    // 2) 先把订单标记为已付款（不影响库存锁，但属于关键状态）
    {
      const { error: payErr } = await supabase
        .from("orders")
        .update({
          payment_status: "paid",
        })
        .eq("order_id", orderId);

      if (payErr) {
        console.error("❌ Update payment_status failed:", orderId, payErr);
        return res.status(500).json({ error: "Update payment_status failed" });
      }
    }

    // 3) ✅ 调用你确认过的 RPC：lock_inventory_v2（关键）
    {
      const { error: rpcErr } = await supabase.rpc("lock_inventory_v2", {
        p_start_date: startDate,
        p_end_date: endDate,
        p_car_model_id: carModelId,
        p_driver_lang: driverLang,
      });

      if (rpcErr) {
        console.error(
          "❌ A2 扣库存 RPC 失败",
          orderId,
          rpcErr
        );
        // 这里必须 500，让 Stripe 重试（库存没锁成功不能放过）
        return res.status(500).json({ error: "Lock inventory failed", detail: rpcErr });
      }
    }

    // 4) 锁成功后：写回 orders.inventory_locked = true（关键）
    {
      const { error: lockFlagErr } = await supabase
        .from("orders")
        .update({
          inventory_locked: true,
        })
        .eq("order_id", orderId);

      if (lockFlagErr) {
        console.error("❌ Update inventory_locked failed:", orderId, lockFlagErr);
        return res.status(500).json({ error: "Update inventory_locked failed" });
      }
    }

    // 5) 下面是“非关键动作”：邮件/新订单提醒 —— 失败不阻断 webhook
    //    （避免你截图里那种：notify 失败 → webhook 500 → Stripe 反复重试）
    try {
      // 订单确认邮件（你已有 /api/send-confirmation-email）
      await fetch(`${process.env.NEXT_PUBLIC_SITE_URL || ""}/api/send-confirmation-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: orderId }),
      });
    } catch (e) {
      console.error("⚠️ send-confirmation-email failed (non-blocking):", orderId, e);
    }

    try {
      // 新订单提醒（你已有 /api/send-notify-new-order）
      await fetch(`${process.env.NEXT_PUBLIC_SITE_URL || ""}/api/send-notify-new-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: orderId }),
      });
    } catch (e) {
      console.error("⚠️ send-notify-new-order failed (non-blocking):", orderId, e);
    }

    // ✅ 一切关键动作完成
    console.log("✅ Webhook done:", orderId);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook handler fatal error:", orderId, err);
    return res.status(500).json({ error: "Webhook handler error" });
  }
}

