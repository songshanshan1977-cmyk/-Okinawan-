import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

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

    // 1️⃣ 查询订单
    const { data: order, error } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", order_id)
      .single();

    if (error || !order) {
      console.error("Order fetch error:", error);
      return res.status(404).json({ error: "Order not found" });
    }

    const balance =
      Math.max((order.total_price || 0) - (order.deposit_amount || 0), 0);

    // 2️⃣ 邮件内容
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;line-height:1.6">
        <h2>冲绳包车服务确认书</h2>

        <p>尊敬的 ${order.name} 您好，</p>
        <p>感谢您预订 <strong>华人Okinawa · HonestOki</strong> 包车服务。</p>

        <h3>📌 订单信息</h3>
        <ul>
          <li>订单编号：${order.order_id}</li>
          <li>用车日期：${order.start_date}</li>
          <li>用车时长：${order.duration} 小时</li>
          <li>出发酒店：${order.departure_hotel}</li>
          <li>结束酒店：${order.end_hotel}</li>
        </ul>

        <h3>💰 费用明细</h3>
        <ul>
          <li>订单总额：¥${order.total_price}</li>
          <li>已付押金：¥${order.deposit_amount}</li>
          <li>尾款（当日支付）：¥${balance}</li>
        </ul>

        <h3>📲 售后支持</h3>
        <p>请添加客服微信：</p>
        <img src="https://your-cdn.com/wechat-qrcode.png" width="180"/>

        <p style="color:#666;font-size:13px">
          本邮件为系统自动发送，请勿回复。
        </p>

        <p>
          —— 华人Okinawa · HonestOki
        </p>
      </div>
    `;

    // 3️⃣ 发送邮件
    await resend.emails.send({
      from: "HonestOki <service@honestoki.com>",
      to: order.email,
      subject: `【订单确认】冲绳包车服务（${order.order_id}）`,
      html,
      reply_to: "noreply@honestoki.com",
    });

    // 4️⃣ 标记邮件已发送
    await supabase
      .from("orders")
      .update({ email_status: "sent" })
      .eq("order_id", order_id);

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
