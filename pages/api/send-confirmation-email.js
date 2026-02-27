// pages/api/send-confirmation-email.js
import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";

const resend = new Resend(process.env.RESEND_API_KEY);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * ✅ 仅新增：best-effort 防重复（不改业务逻辑）
 * 60 秒内，同一个 order_id 的发送请求只处理一次。
 */
global.__EMAIL_DEDUPE__ = global.__EMAIL_DEDUPE__ || new Map();

function shouldBlockDuplicate(key, ttlMs = 60 * 1000) {
  const now = Date.now();
  const hit = global.__EMAIL_DEDUPE__.get(key);

  if (global.__EMAIL_DEDUPE__.size > 500) {
    for (const [k, v] of global.__EMAIL_DEDUPE__.entries()) {
      if (now - v > ttlMs) global.__EMAIL_DEDUPE__.delete(k);
    }
  }

  if (hit && now - hit < ttlMs) return true;
  global.__EMAIL_DEDUPE__.set(key, now);
  return false;
}

const carNameMap = {
  car1: "经济 5 座轿车",
  car2: "豪华 7 座阿尔法",
  car3: "舒适 10 座海狮",
};

const driverLangMap = {
  zh: "中文司机",
  jp: "日文司机",
  ZH: "中文司机",
  JP: "日文司机",
};

const CAR_MODEL_ID_NAME_MAP = {
  "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca": "经济 5 座轿车",
  "82cf604f-e688-49fe-aecf-69894a01f6cb": "豪华 7 座阿尔法",
  "453df662-d350-4ab9-b811-61ffcda40d4b": "舒适 10 座海狮",
};

function getCarDisplay(order) {
  if (order.car_model && carNameMap[order.car_model]) return carNameMap[order.car_model];
  if (order.car_model_id && CAR_MODEL_ID_NAME_MAP[order.car_model_id])
    return CAR_MODEL_ID_NAME_MAP[order.car_model_id];
  return order.car_model
    ? order.car_model || order.car_model_id || "-"
    : "-";
}

function getDriverLangDisplay(order) {
  return driverLangMap[order.driver_lang] || order.driver_lang || "-";
}

export default async function handler(req, res) {

  // ✅ ===== 仅新增：CORS + OPTIONS 支持 =====
  const allowedOrigins = [
    "https://华人okinawa.com",
    "https://www.华人okinawa.com",
    "https://xn--okinawa-n14kh45a.com",
    "https://www.xn--okinawa-n14kh45a.com",
  ];

  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  // ===== CORS 结束 =====

  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const startedAt = new Date().toISOString();

  try {
    const { order_id } = req.body || {};
    if (!order_id) return res.status(400).json({ error: "order_id missing" });

    const dedupeKey = `send-confirmation-email:${order_id}`;
    if (shouldBlockDuplicate(dedupeKey)) {
      return res.status(200).json({
        ok: true,
        deduped: true,
        message: "Duplicate request blocked (within 60s)",
      });
    }

    const { data: order, error } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", order_id)
      .single();

    if (error || !order) {
      console.error("❌ Order fetch error:", error);
      return res.status(404).json({ error: "Order not found" });
    }

    const balance = Math.max(
      (order.total_price || 0) - (order.deposit_amount || 500),
      0
    );

    const dateText =
      order.end_date && order.end_date !== order.start_date
        ? `${order.start_date} → ${order.end_date}`
        : order.start_date;

    const subject = `HonestOki 预约确认｜订单 ${order.order_id}`;

    const html = `
      <div style="font-family: Arial, sans-serif; line-height:1.7; max-width:680px; margin:0 auto;">
        <h2 style="margin:0 0 10px;">押金支付成功｜订单已确认</h2>
        <p style="margin:0 0 18px; color:#333;">请核对以下订单信息（与订单表一致）：</p>
        ...
      </div>
    `;

    let resendResp;
    try {
      resendResp = await resend.emails.send({
        from: "HonestOki <no-reply@xn--okinawa-n14kh45a.com>",
        to: order.email,
        subject,
        html,
      });
    } catch (mailErr) {
      await supabase.from("send_logs").insert({
        order_id: order.order_id,
        email: order.email,
        subject,
        status: "failed",
        error_message: mailErr?.message || String(mailErr),
        created_at: startedAt,
      });

      await supabase
        .from("orders")
        .update({ email_status: "failed" })
        .eq("order_id", order_id);

      throw mailErr;
    }

    await supabase.from("send_logs").insert({
      order_id: order.order_id,
      email: order.email,
      subject,
      status: "sent",
      error_message: null,
      provider_message_id: resendResp?.data?.id || null,
      created_at: startedAt,
    });

    await supabase
      .from("orders")
      .update({ email_status: "sent" })
      .eq("order_id", order_id);

    return res.status(200).json({ ok: true, resend: resendResp });
  } catch (err) {
    console.error("❌ Send email error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
