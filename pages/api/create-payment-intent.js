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

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const { orderId, priceId } = req.body;

    if (!orderId || !priceId) {
      return res.status(400).json({ error: "缺少 orderId 或 priceId" });
    }

    // 查询订单
    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", orderId)
      .single();

    if (!order) {
      return res.status(404).json({ error: "订单不存在" });
    }

    // 创建 Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        { price: priceId, quantity: 1 }
      ],
      customer_email: order.email || undefined,
      metadata: { orderId },
      success_url: `${FRONTEND_URL}/booking?step=5&orderId=${orderId}`,
      cancel_url: `${FRONTEND_URL}/booking?step=4&orderId=${orderId}&cancel=1`,
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error("❌ create-payment-intent 错误：", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
