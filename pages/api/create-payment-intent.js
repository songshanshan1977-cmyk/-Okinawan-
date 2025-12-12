// pages/api/create-payment-intent.js

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2022-11-15",
});

// ⭐ 使用 service_role，只在后端
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ⭐ 前端成功 / 取消跳转地址
const FRONTEND_URL = "https://xn--okinawa-n14kh45a.com";

// ⭐ 固定押金（人民币：分）
const DEPOSIT_AMOUNT = 50000; // ¥500 CNY

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { orderId } = req.body;

    // ① 参数校验：只需要 orderId
    if (!orderId) {
      return res.status(400).json({ error: "缺少 orderId" });
    }

    // ② 查询订单
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", orderId)
      .single();

    if (orderError || !order) {
      return res.status(404).json({ error: "订单不存在" });
    }

    // ③ 防止重复支付（如果你有这个字段）
    if (order.payment_status === "paid") {
      return res.status(400).json({ error: "该订单已完成支付" });
    }

    // ④ 创建 Stripe Checkout Session（人民币押金）
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"], // 微信/支付宝是否显示取决于 Stripe 账号配置
      line_items: [
        {
          price_data: {
            currency: "cny",
            product_data: {
              name: "冲绳包车押金",
              description: `订单号 ${orderId} 的押金`,
            },
            unit_amount: DEPOSIT_AMOUNT,
          },
          quantity: 1,
        },
      ],
      customer_email: order.email || undefined,
      metadata: {
        orderId,
        type: "deposit",
        currency: "CNY",
      },
      success_url: `${FRONTEND_URL}/booking?step=5&orderId=${orderId}`,
      cancel_url: `${FRONTEND_URL}/booking?step=4&orderId=${orderId}&cancel=1`,
    });

    // ⑤ 返回 Stripe 跳转地址
    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error("❌ create-payment-intent 错误：", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
