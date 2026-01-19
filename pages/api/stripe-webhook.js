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
  return "ZH";
}

function pickOrderId(session) {
  return (
    session?.metadata?.order_id ||
    session?.metadata?.orderId ||
    session?.client_reference_id
  );
}

async function markPaid(orderId) {
  // 幂等：重复写 paid 没问题
  const { error } = await supabase
    .from("orders")
    .update({ payment_status: "paid" })
    .eq("order_id", orderId);

  if (error) {
    console.error("⚠️ update payment_status failed:", orderId, error);
  }
}

async function markLocked(orderId) {
  const { error } = await supabase
    .from("orders")
    .update({ inventory_locked: true })
    .eq("order_id", orderId);

  if (error) {
    console.error("⚠️ mark inventory_locked failed:", orderId, error);
    return { ok: false, error };
  }
  return { ok: true };
}

// 用 inventory 表兜底判断：是否已经锁过（locked_qty > 0）
async function alreadyLockedInInventory({ date, carModelId, driverLang }) {
  const { data, error } = await supabase
    .from("inventory")
    .select("locked_qty")
    .eq("date", date)
    .eq("car_model_id", carModelId)
    .eq("driver_lang", driverLang)
    .maybeSingle();

  if (error) {
    console.error("⚠️ read inventory failed:", error);
    return { ok: false, locked: false, error };
  }

  const lockedQty = Number(data?.locked_qty ?? 0);
  return { ok: true, locked: lockedQty > 0, lockedQty };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  let event;

  // 1) Stripe 签名校验
  try {
    const rawBody = await buffer(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("❌ Stripe signature verify failed:", err?.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 2) 业务处理
  try {
    // ✅ 只处理最关键事件
    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({ received: true, ignored: event.type });
    }

    const session = event.data.object;
    const orderId = pickOrderId(session);

    if (!orderId) {
      console.error("❌ missing order_id in session metadata");
      return res
        .status(200)
        .json({ received: true, ok: false, reason: "missing_order_id" });
    }

    // 读订单（拿锁库存必需字段）
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select(
        "order_id, payment_status, inventory_locked, car_model_id, start_date, end_date, driver_lang"
      )
      .eq("order_id", orderId)
      .maybeSingle();

    if (orderErr) {
      console.error("❌ load order error:", orderErr);
      // 这里返回 200，避免 Stripe 无限重试打爆（你现在要稳）
      return res
        .status(200)
        .json({ received: true, ok: false, error: "load_order_failed", detail: orderErr });
    }

    if (!order) {
      console.error("❌ order not found:", orderId);
      return res
        .status(200)
        .json({ received: true, ok: false, reason: "order_not_found" });
    }

    // 先标记 paid（幂等）
    await markPaid(orderId);

    // ✅ 幂等保护：已经标记 locked 的直接跳过
    if (order.inventory_locked === true) {
      console.log("✅ inventory already locked, skip. order_id=", orderId);
      return res
        .status(200)
        .json({ received: true, ok: true, skipped: "already_locked" });
    }

    // 组装锁库存参数（目前你只用 1/18 这种单日也 OK）
    const startDate = order.start_date;
    const endDate = order.end_date || order.start_date;
    const carModelId = order.car_model_id;
    const driverLang = normalizeLang(order.driver_lang);

    // 先尝试锁库存
    const { error: lockErr } = await supabase.rpc("lock_inventory_v2", {
      p_start_date: startDate,
      p_end_date: endDate,
      p_car_model_id: carModelId,
      p_driver_lang: driverLang,
    });

    if (lockErr) {
      console.error("❌ A2 扣库存 RPC 失败", orderId, lockErr);

      // ⭐⭐ 关键兜底：P0001 常见于 “已锁成功 + Stripe 重发/你点重发” 或 “锁成功但来不及写 inventory_locked”
      if (lockErr?.code === "P0001") {
        const check = await alreadyLockedInInventory({
          date: startDate, // 你现在用单日，range 也先按 startDate 兜底足够
          carModelId,
          driverLang,
        });

        if (check.ok && check.locked) {
          // 说明 inventory 已经锁过 → 把 orders.inventory_locked 补写成 true
          await markLocked(orderId);
          return res.status(200).json({
            received: true,
            ok: true,
            skipped: "already_locked_in_inventory",
            locked_qty: check.lockedQty,
          });
        }
      }

      // 不让 Stripe 重试（返回 200），并保留失败信息给你排查
      return res.status(200).json({
        received: true,
        ok: false,
        error: "lock_inventory_failed",
        detail: lockErr,
      });
    }

    // 锁成功 → 写回订单 inventory_locked=true
    const mark = await markLocked(orderId);
    if (!mark.ok) {
      // 锁成功了，不要让 Stripe 重试导致二次锁
      return res.status(200).json({
        received: true,
        ok: true,
        warn: "locked_but_mark_failed",
        detail: mark.error,
      });
    }

    return res.status(200).json({ received: true, ok: true });
  } catch (err) {
    console.error("❌ webhook handler fatal error:", err);
    // 你现在最需要“稳”，这里也返回 200 避免 Stripe 重试风暴
    return res.status(200).json({
      received: true,
      ok: false,
      error: "handler_fatal",
      message: err?.message,
    });
  }
}

