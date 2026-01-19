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

// ✅ 只允许用环境变量拿站点域名（防止手机端/代理导致 host 推断错误）
function getSiteUrlFromEnv() {
  const u = (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "").trim();
  return u ? u.replace(/\/$/, "") : "";
}

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: "orderId missing" });

    const siteUrl = getSiteUrlFromEnv();
    if (!siteUrl) {
      return res.status(500).json({
        error:
          "SITE_URL missing. Please set NEXT_PUBLIC_SITE_URL (or SITE_URL) in Vercel Production env.",
      });
    }

    // 1) 读取订单（不改库存逻辑）
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("order_id, deposit_amount")
      .eq("order_id", orderId)
      .single();

    if (orderErr || !order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // ✅ 手机端支付完成后必须回跳到 Step5
    const successUrl = `${siteUrl}/booking?step=5&order_id=${encodeURIComponent(
      order.order_id
    )}`;
    const cancelUrl = `${siteUrl}/booking?step=4&order_id=${encodeURIComponent(
      order.order_id
    )}`;

    const deposit = Number(order.deposit_amount || 500);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",

      // ✅【仅新增】明确声明支付方式（提高支付宝可用性）
      payment_method_types: ["card", "alipay"],

      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "cny",
            unit_amount: Math.round(deposit * 100),
            product_data: { name: "冲绳包车押金" },
          },
        },
      ],

      success_url: successUrl,
      cancel_url: cancelUrl,

      // ✅ 让 webhook 能拿到订单号
      client_reference_id: order.order_id,
      metadata: { order_id: order.order_id },
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("create-payment-intent error:", e);
    return res
      .status(500)
      .json({ error: e?.message || "Internal Server Error" });
  }
}



