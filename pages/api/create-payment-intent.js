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

// ✅ 统一拿站点域名（你 Vercel 里已经加了 NEXT_PUBLIC_SITE_URL）
function getSiteUrl(req) {
  const fromEnv =
    process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "";
  if (fromEnv) return fromEnv.replace(/\/$/, "");

  // 兜底：用当前请求 host（防止环境变量没生效）
  const proto =
    (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0];
  const host =
    (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`.replace(/\/$/, "");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: "orderId missing" });

    // 1) 读取订单（用于校验/补充信息；不改你的库存逻辑）
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("order_id, deposit_amount")
      .eq("order_id", orderId)
      .single();

    if (orderErr || !order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const siteUrl = getSiteUrl(req);

    // ✅ 关键：手机端支付完成后必须回跳到 Step5
    const successUrl = `${siteUrl}/booking?step=5&order_id=${encodeURIComponent(
      order.order_id
    )}`;
    const cancelUrl = `${siteUrl}/booking?step=4&order_id=${encodeURIComponent(
      order.order_id
    )}`;

    // 2) 创建 Stripe Checkout Session
    const deposit = Number(order.deposit_amount || 500);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      // ✅ RMB
      currency: "cny",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "cny",
            unit_amount: Math.round(deposit * 100), // 分
            product_data: { name: "冲绳包车押金" },
          },
        },
      ],

      // ✅ 这俩就是手机端回不来的核心
      success_url: successUrl,
      cancel_url: cancelUrl,

      // ✅ 让 webhook 能拿到订单号（不改你现有流程）
      client_reference_id: order.order_id,
      metadata: { order_id: order.order_id },
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("create-payment-intent error:", e);
    return res.status(500).json({ error: e?.message || "Internal Server Error" });
  }
}


