// pages/api/send-confirmation-email.js

import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";

// ⭐ Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// ⭐ Supabase（Service Role）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = new Date().toISOString();

  try {
    const { order_id } = req.body;

    if (!order_id) {
      return res.status(400).json({ error: "order_id missing" });
    }

    // 1️⃣ 读取订单
    const { data: order, error } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", order_id)
      .single();

    if (error || !order) {
      console.error("❌ Order fetch error:", error);
      return res.status(404).json({ error: "Order not found" });
    }

    // 2️⃣ 计算尾款
    const balance = Math.max(
      (order.total_price || 0) - (order.deposit_amount || 0),
      0
    );

    // 3️⃣ 用车日期显示（支持多日）
    const dateText =
      order.end_date && order.end_date !== order.start_date
        ? `${order.start_date} → ${order.end_date}`
        : order.start_date;

    // 4️⃣ 邮件 HTML
    const subject = `您的冲绳包车订单确认（${order.order_id}）`;

    const html = `
      <div style="font-family: Arial, sans-serif; line-height:1.6; max-width:600px; margin:0 auto;">
        <h2>冲绳包车服务确认书</h2>

        <p>尊敬的 ${order.name} 您好，</p>
        <p>您已成功预订 <strong>华人 Okinawa 包车服务</strong>，订单详情如下：</p>

        <h3>📄 订单信息</h3>
        <ul>
          <li><strong>订单编号：</strong> ${order.order_id}</li>
          <li><strong>用车日期：</strong> ${dateText}</li>
          <li><strong>出发酒店：</strong> ${order.departure_hotel || "-"}</li>
          <li><strong>结束酒店：</strong> ${order.end_hotel || "-"}</li>
        </ul>

        <h3>💰 费用明细</h3>
        <ul>
          <li><strong>包车总费用：</strong> ¥${order.total_price}</li>
          <li><strong>已支付押金：</strong> ¥${order.deposit_amount}</li>
          <li><strong>尾款（用车当日支付司机）：</strong> ¥${balance}</li>
        </ul>

        <h3>📞 联系客服</h3>
        <p>如需修改订单或紧急联系，请通过以下方式联系我们：</p>

        <div style="display:flex; gap:16px; margin-top:12px;">
          <div style="text-align:center;">
            <div>WhatsApp</div>
            <img
              src="https://okinawan.vercel.app/w2.png"
              width="120"
              style="border:1px solid #eee;"
            />
          </div>

          <div style="text-align:center;">
            <div>微信</div>
            <img
              src="https://okinawan.vercel.app/w1.png.png"
              width="120"
              style="border:1px solid #eee;"
            />
          </div>
        </div>

        <p style="margin-top:16px; color:#666;">
          📩 本邮件为系统自动发送，请勿直接回复。
        </p>

        <p style="margin-top:24px;">
          —— <br/>
          华人 Okinawa 包车服务团队
        </p>
      </div>
    `;

    // 5️⃣ 发送邮件
    let resendResp;
    try {
      resendResp = await resend.emails.send({
        from: "华人 Okinawa <no-reply@xn--okinawa-n14kh45a.com>",
        to: order.email,
        subject,
        html,
      });
    } catch (mailErr) {
      // ⭐ 失败也要写 send_logs
      await supabase.from("send_logs").insert({
        order_id: order.order_id,
        email: order.email,
        subject,
        status: "failed",
        error_message: mailErr?.message || String(mailErr),
        created_at: startedAt,
      });

      // 同步订单邮件状态（可选，但你现在中控要看异常，建议写）
      await supabase
        .from("orders")
        .update({ email_status: "failed" })
        .eq("order_id", order_id);

      throw mailErr;
    }

    // 6️⃣ 写 send_logs（成功）
    await supabase.from("send_logs").insert({
      order_id: order.order_id,
      email: order.email,
      subject,
      status: "sent",
      error_message: null,
      // Resend 返回里一般会有 id；没有也不影响
      provider_message_id: resendResp?.data?.id || null,
      created_at: startedAt,
    });

    // 7️⃣ 更新订单邮件状态
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


