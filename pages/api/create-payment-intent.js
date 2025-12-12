// pages/api/create-payment-intent.js

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2022-11-15",
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FRONTEND_URL = "https://xn--okinawa-n14kh45a.com";

// 押金：人民币 500 元（Stripe 用分）
const DEPOSIT_AMOUNT = 50000;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: "缺少 orderId" });
    }

    console.log("🔍 create-payment-intent 查询订单：", orderId);

    // 👉 用 order_id 查询
    const { data: order, error } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", orderId.trim())
      .maybeSingle();

    if (error) {
      console.error("❌ 查询 orders 出错：", error);
      return res.status(500).json({ error: "查询订单失败" });
    }

    if (!order) {
      console.warn("⚠️ 未找到订单，order_id =", orderId);
      return res.status(404).json({ error: "订单不存在" });
    }

    console.log("✅ 找到订单 UUID =", order.id);

    // 防止重复支付
    if (order.payment_status === "paid") {
      return res.status(400).json({ error: "订单已支付" });
    }

    /**
     * ⭐⭐⭐ 核心：一次性把 webhook 需要的字段全部写进 metadata ⭐⭐⭐
     */
    const metadata = {
      order_id: order.order_id,
      order_uuid: order.id,
      car_model_id: order.car_model_id,
      start_date: order.start_date,
      end_date: order.end_date,
      type: "deposit",
    };

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],

      line_items: [
        {
          price_data: {
            currency: "cny",
            product_data: {
              name: "冲绳包车押金",
              description: `订单号 ${order.order_id}`,
            },
            unit_amount: DEPOSIT_AMOUNT,
          },
          quantity: 1,
        },
      ],

      customer_email: order.email || undefined,

      // 👉 payment_intent 里一份
      payment_intent_data: {
        metadata,
      },

      // 👉 session 自己也留一份（双保险）
      metadata,

      success_url: `${FRONTEND_URL}/booking?step=5&orderId=${order.order_id}`,
      cancel_url: `${FRONTEND_URL}/booking?step=4&orderId=${order.order_id}&cancel=1`,
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error("🔥 create-payment-intent 未捕获异常：", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}


