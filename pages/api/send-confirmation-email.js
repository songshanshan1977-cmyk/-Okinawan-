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
 * - 返回 200，不报错（避免 Appsmith 连点导致重复邮件）
 * - 这是内存级去重：不同实例/冷启动时会重置，但配合前端锁已足够
 */
global.__EMAIL_DEDUPE__ = global.__EMAIL_DEDUPE__ || new Map();

function shouldBlockDuplicate(key, ttlMs = 60 * 1000) {
  const now = Date.now();
  const hit = global.__EMAIL_DEDUPE__.get(key);

  // 轻量清理：避免 Map 无限增长
  if (global.__EMAIL_DEDUPE__.size > 500) {
    for (const [k, v] of global.__EMAIL_DEDUPE__.entries()) {
      if (now - v > ttlMs) global.__EMAIL_DEDUPE__.delete(k);
    }
  }

  if (hit && now - hit < ttlMs) return true;
  global.__EMAIL_DEDUPE__.set(key, now);
  return false;
}

// ✅ 恢复“人话”显示（按你前端 Step3/Step4 的风格）
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

// 兜底：uuid -> 人话（按你已固定的 UUID）
const CAR_MODEL_ID_NAME_MAP = {
  "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca": "经济 5 座轿车",
  "82cf604f-e688-49fe-aecf-69894a01f6cb": "豪华 7 座阿尔法",
  "453df662-d350-4ab9-b811-61ffcda40d4b": "舒适 10 座海狮",
};

function getCarDisplay(order) {
  // 优先用 car_model (car1/2/3)，否则用 car_model_id (uuid)
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
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const startedAt = new Date().toISOString();

  try {
    const { order_id } = req.body || {};
    if (!order_id) return res.status(400).json({ error: "order_id missing" });

    // ✅ 仅新增：防重复（同 order_id 60 秒内只发送一次）
    const dedupeKey = `send-confirmation-email:${order_id}`;
    if (shouldBlockDuplicate(dedupeKey)) {
      return res.status(200).json({
        ok: true,
        deduped: true,
        message: "Duplicate request blocked (within 60s)",
      });
    }

    // 1) 读订单
    const { data: order, error } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", order_id)
      .single();

    if (error || !order) {
      console.error("❌ Order fetch error:", error);
      return res.status(404).json({ error: "Order not found" });
    }

    // 2) 尾款
    const balance = Math.max(
      (order.total_price || 0) - (order.deposit_amount || 500),
      0
    );

    // 3) 日期显示（多日/单日）
    const dateText =
      order.end_date && order.end_date !== order.start_date
        ? `${order.start_date} → ${order.end_date}`
        : order.start_date;

    const subject = `HonestOki 预约确认｜订单 ${order.order_id}`;

    // ✅ 邮件内容恢复“信息齐全、像订单确认单”
    const html = `
      <div style="font-family: Arial, sans-serif; line-height:1.7; max-width:680px; margin:0 auto;">
        <h2 style="margin:0 0 10px;">押金支付成功｜订单已确认</h2>
        <p style="margin:0 0 18px; color:#333;">请核对以下订单信息（与订单表一致）：</p>

        <div style="border:1px solid #eee; border-radius:10px; padding:16px;">
          <h3 style="margin:0 0 8px;">📄 订单信息</h3>
          <p style="margin:6px 0;"><b>订单号：</b>${order.order_id}</p>
          <p style="margin:6px 0;"><b>用车日期：</b>${dateText || "-"}</p>
          <p style="margin:6px 0;"><b>出发酒店：</b>${order.departure_hotel || "-"}</p>
          <p style="margin:6px 0;"><b>结束酒店：</b>${order.end_hotel || "-"}</p>

          <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

          <h3 style="margin:0 0 8px;">🚗 用车信息</h3>
          <p style="margin:6px 0;"><b>车型：</b>${getCarDisplay(order)}</p>
          <p style="margin:6px 0;"><b>司机语言：</b>${getDriverLangDisplay(order)}</p>
          <p style="margin:6px 0;"><b>包车时长：</b>${order.duration || "-"} 小时</p>
          <p style="margin:6px 0;"><b>人数：</b>${order.pax ?? "-"}</p>
          <p style="margin:6px 0;"><b>行李：</b>${order.luggage ?? "-"}</p>
          ${
            order.itinerary
              ? `<p style="margin:6px 0;"><b>行程：</b>${order.itinerary}</p>`
              : ""
          }
          ${
            order.remark
              ? `<p style="margin:6px 0;"><b>备注：</b>${order.remark}</p>`
              : ""
          }

          <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

          <h3 style="margin:0 0 8px;">💰 费用明细</h3>
          <p style="margin:6px 0;"><b>包车总费用：</b>¥${order.total_price || 0}</p>
          <p style="margin:6px 0;"><b>已支付押金：</b>¥${order.deposit_amount || 500}</p>
          <p style="margin:6px 0;"><b>尾款（用车当日支付司机）：</b>¥${balance}</p>

          <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

          <h3 style="margin:0 0 8px;">📞 联系人信息</h3>
          <p style="margin:6px 0;"><b>姓名：</b>${order.name || "-"}</p>
          <p style="margin:6px 0;"><b>电话：</b>${order.phone || "-"}</p>
          <p style="margin:6px 0;"><b>邮箱：</b>${order.email || "-"}</p>
        </div>

        <p style="margin-top:16px; color:#666;">
          如需修改行程或咨询，请直接回复此邮件，我们会尽快联系您。
        </p>

        <p style="margin-top:22px;">
          ——<br/>
          HonestOki 华人 Okinawa 包车服务
        </p>
      </div>
    `;

    // 发送邮件
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

