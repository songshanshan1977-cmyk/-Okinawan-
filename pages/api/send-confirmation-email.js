// pages/api/send-confirmation-email.js
import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";

const resend = new Resend(process.env.RESEND_API_KEY);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * 防重复发送（60 秒）
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

/**
 * 车型显示
 */
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
  return order.car_model || order.car_model_id || "-";
}

function getDriverLangDisplay(order) {
  return driverLangMap[order.driver_lang] || order.driver_lang || "-";
}

export default async function handler(req, res) {

  // CORS
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
        message: "Duplicate request blocked",
      });
    }

    const { data: order, error } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", order_id)
      .single();

    if (error || !order) {
      console.error("Order fetch error:", error);
      return res.status(404).json({ error: "Order not found" });
    }

    const carDisplay = getCarDisplay(order);
    const driverDisplay = getDriverLangDisplay(order);

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
<div style="font-family: Arial, sans-serif; line-height:1.7; max-width:680px; margin:0 auto; padding:20px">

<h2 style="margin-bottom:10px;">押金支付成功｜订单已确认</h2>

<p style="color:#333;margin-bottom:20px;">
请核对以下订单信息（与订单表一致）
</p>

<hr/>

<p><b>订单编号：</b> ${order.order_id}</p>

<hr/>

<p><b>行程：</b> ${order.trip_route || "-"}</p>
<p><b>车型：</b> ${carDisplay}</p>
<p><b>司机语言：</b> ${driverDisplay}</p>
<p><b>包车时长：</b> ${order.duration || "-"} 小时</p>
<p><b>人数：</b> ${order.passengers || "-"} 人</p>
<p><b>行李：</b> ${order.luggage || "0"} 件</p>

<hr/>

<p><b>用车日期：</b> ${dateText}</p>
<p><b>出发酒店：</b> ${order.departure_hotel || "-"}</p>
<p><b>结束酒店：</b> ${order.end_hotel || "-"}</p>

<hr/>

<p><b>姓名：</b> ${order.customer_name || "-"}</p>
<p><b>电话：</b> ${order.phone || "-"}</p>
<p><b>微信：</b> ${order.wechat || "-"}</p>
<p><b>邮箱：</b> ${order.email || "-"}</p>

<hr/>

<p><b>包车总费用：</b> ¥${order.total_price || "-"}</p>

<p style="margin-top:10px;">
尾款 <b>¥${balance}</b> 请于用车当天支付司机
</p>

<hr/>

<p style="text-align:center;margin-top:20px;">
如需售后或咨询，请扫描微信二维码
</p>

<div style="text-align:center;margin-top:10px;">
<img src="https://华人okinawa.com/wechat-qrcode.jpg" width="180"/>
</div>

<p style="text-align:center;color:#666;margin-top:20px;">
HonestOki 冲绳包车服务
</p>

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

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("Send email error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
