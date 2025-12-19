// pages/api/send-confirmation-email.js

import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";

const resend = new Resend(process.env.RESEND_API_KEY);

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
      console.error("Order fetch error:", error);
      return res.status(404).json({ error: "Order not found" });
    }

    const balance = Math.max(
      (order.total_price || 0) - (order.deposit_amount || 0),
      0
    );

    // 2️⃣ 邮件内容
    const html = `
      <div style="font-family: Arial; line-height: 1.6; max-width: 600px;">
        <h2>冲绳包车服务确认书</h2>
        <p>尊敬的 ${order.name} 您好，</p>
        <p>您已成功预订冲绳包车服务，订单详情如下：</p>

        <h3>订单信息</h3>
        <ul>
          <li><strong>订单编号：</strong> ${order.order_id}</li>
          <li><strong>用车日期：</strong> ${order.start_date}</li>
          <li><strong>出发酒店：</strong> ${order.departure_hotel}</li>
          <li><strong>结束酒店：</strong> ${order.end_hotel}</li>
        </ul>

        <h3>费用明细</h3>
        <ul>
          <li><strong>总费用：</strong> ¥${order.total_price}</li>
          <li><strong>已付押金：</strong> ¥${order.deposit_amount}</li>
          <li><strong>尾款（当日支付）：</strong> ¥${balance}</li>
        </ul>

        <p>
          📩 本邮件为系统自动发送，请勿直接回复。<br/>
          📞 客服 WhatsApp / 微信：请扫描下方二维码
        </p>

        <p style="margin-top:20px;">
          —— 华人Okinawa 包车服务团队
        </p>
      </div>
    `;

    // 3️⃣ 发送邮件（⭐ 关键修复点）
    await resend.emails.send({
      from: "HonestOki <no-reply@华人okinawa.com>",
      to: order.email,
      subject: `您的冲绳包车订单确认（${order.order_id}）`,
      html,
    });

    // 4️⃣ 更新订单状态
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

