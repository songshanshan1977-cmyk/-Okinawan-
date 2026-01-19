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

// 读取 raw body（Stripe 签名校验必须用 raw body）
async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function normalizeLang(v) {
  const s = String(v || "").trim().toUpperCase();
  if (s === "ZH" || s === "CN" || s === "CH" || s === "中文") return "ZH";
  if (s === "JP" || s === "JA" || s === "JPN" || s === "日文" || s === "日本語")
    return "JP";
  // 默认 ZH（避免空值）
  return "ZH";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  let event;

  try {
    const rawBody = await buffer(req);
    const sig = req.headers["stripe-signature"];

    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("❌ Stripe signature verify failed:", err?.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // ✅ 只处理你最关键的事件
    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({ received: true, ignored: event.type });
    }

    const session = event.data.object;

    // 订单号优先从 metadata 拿（你系统里就是这么设计的）
    const orderId =
      session?.metadata?.order_id ||
      session?.metadata?.orderId ||
      session?.client_reference_id;

    if (!orderId) {
      console.error("❌ missing order_id in session metadata");
      return res.status(200).json({ received: true, ok: false, reason: "missing_order_id" });
    }

    // 1) 读订单（拿到锁库存所需字段）
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("order_id, payment_status, inventory_locked, car_model_id, start_date, end_date, driver_lang")
      .eq("order_id", orderId)
      .maybeSingle();

    if (orderErr) {
      console.error("❌ load order error:", orderErr);
      return res.status(500).json({ error: "load order failed", detail: orderErr });
    }
    if (!order) {
      console.error("❌ order not found:", orderId);
      return res.status(200).json({ received: true, ok: false, reason: "order_not_found" });
    }

    // 2) 先把订单标记 paid（幂等：重复写同样值没问题）
    //    ⚠️ 只更新你确定存在的字段，避免 schema 不一致报错
    await supabase
      .from("orders")
      .update({ payment_status: "paid" })
      .eq("order_id", orderId);

    // 3) ✅ 幂等保护：如果这单已经 inventory_locked=true，就不要再锁一次
    if (order.inventory_locked === true) {
      console.log("✅ inventory already locked, skip. order_id=", orderId);
      return res.status(200).json({ received: true, ok: true, skipped: "already_locked" });
    }

    // 4) 锁库存（用你现在确认的 v2）
    const startDate = order.start_date;
    const endDate = order.end_date || order.start_date;
    const carModelId = order.car_model_id;
    const driverLang = normalizeLang(order.driver_lang);

    const { error: lockErr } = await supabase.rpc("lock_inventory_v2", {
      p_start_date: startDate,
      p_end_date: endDate,
      p_car_model_id: carModelId,
      p_driver_lang: driverLang,
    });

    if (lockErr) {
      // ⭐ 关键：不要让 Stripe 无限重试把你打爆
      // P0001 = 你函数里 raise 的“无库存可锁”
      console.error("❌ A2 扣库存 RPC 失败", orderId, lockErr);

      // 这里返回 200（已接收），但告诉你 webhook 内部失败原因
      // 后续你可以在后台做“库存异常”KPI 再处理（你之前也规划了）
      return res.status(200).json({
        received: true,
        ok: false,
        error: "lock inventory failed",
        detail: lockErr,
      });
    }

    // 5) 锁成功后，再标记订单 inventory_locked=true
    const { error: markErr } = await supabase
      .from("orders")
      .update({ inventory_locked: true })
      .eq("order_id", orderId);

    if (markErr) {
      console.error("⚠️ inventory locked but mark order failed:", orderId, markErr);
      // 锁成功了，不要让 Stripe 重试导致二次锁
      return res.status(200).json({ received: true, ok: true, warn: "mark_failed", detail: markErr });
    }

    return res.status(200).json({ received: true, ok: true });
  } catch (err) {
    console.error("❌ webhook handler fatal error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err?.message });
  }
}

