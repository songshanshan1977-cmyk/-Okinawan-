// pages/api/send-confirmation-email.js

import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";

// ⭐ Resend 客户端
const resend = new Resend(process.env.RESEND_API_KEY);

// ⭐ Supabase Service Role（仅在 Server 使用）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { order_id } = req.body;

    if (!order_id) {
      return res.status(400).json({ error: "order_id missing" });
    }

    // 1️⃣ 获取订单
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

    // 3️⃣ 邮件 HTML 内容（仅客户确认邮件）
    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; max-width: 600px; margin: 0 auto;">
        <h2>冲绳包车服务确认书</h2>

        <p>尊敬的 ${order.name} 您好，</p>
        <p>您已成功预订 <strong>华人 Okinawa 包车服务</strong>，订单详情如下：</p>

        <h3>📄 订单信息</h3>
        <ul>
          <li><strong>订单编号：</strong> ${order.order_id}</li>
          <li><strong>用车日期：</strong> ${order.start_date}</li>
          <li><strong>出发酒店：</strong> ${order.departure_hotel}</li>
          <li><strong>结束酒店：</strong> ${order.end_hotel}</li>
        </ul>

        <h3>💰 费用明细</h3>
        <ul>
          <li><strong>包车总费用：</strong> ¥${order.total_price}</li>
          <li><strong>已支付押金：</strong> ¥${order.deposit_amount}</li>
          <li><strong>尾款（用车当日支付司机）：</strong> ¥${balance}</li>
        </ul>

        <p style="margin-top:16px; color:#666;">
          📩 本邮件为系统自动发送，请勿直接回复。
        </p>

        <p style="margin-top:24px;">
          —— <br/>
          华人 Okinawa 包车服务团队
        </p>
      </div>
    `;

    // 4️⃣ 发送邮件（使用已验证域名）
    await resend.emails.send({
      from: "华人 Okinawa 包车服务 <no-reply@xn--okinawa-n14kh45a.com>",
      to: order.email,
      subject: `您的冲绳包车订单确认（${order.order_id}）`,
      html,
    });

    // 5️⃣ 更新订单邮件状态
    await supabase
      .from("orders")
      .update({ email_status: "sent" })
      .eq("order_id", order_id);

    console.log("📧 确认邮件已发送：", order.order_id);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Send email error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}


