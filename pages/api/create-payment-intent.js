// pages/api/create-payment-intent.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
const { checkAvailability } = require("../../lib/inventory/checkAvailability");

// --------------------
// CORS
// --------------------
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// --------------------
// Env
// --------------------
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

const supabase = createClient(supabaseUrl, serviceRoleKey);
const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2022-11-15",
});

// ✅ 只允许用环境变量拿站点域名（防止手机端/代理导致 host 推断错误）
function getSiteUrlFromEnv() {
  const u = (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "").trim();
  return u ? u.replace(/\/$/, "") : "";
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { orderId } = req.body || {};

    if (!orderId) {
      return res.status(400).json({ error: "orderId is required" });
    }

    const siteUrl = getSiteUrlFromEnv();
    if (!siteUrl) {
      return res.status(500).json({
        error:
          "SITE_URL missing. Please set NEXT_PUBLIC_SITE_URL (or SITE_URL) in Vercel Production env.",
      });
    }

    // 1) 读取订单（新增：为了库存复查，多取 start_date/end_date/car_model_id/driver_lang）
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select(
        "order_id, deposit_amount, start_date, end_date, car_model_id, driver_lang"
      )
      .eq("order_id", orderId)
      .single();

    if (orderErr || !order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // ------------------------------------------------------------
    // ✅ 新增：创建 Stripe Checkout Session 前，服务端再次检查完整日期范围
    // 只读检查，不建立占位、不加锁——冻结规则 6/7
    // ------------------------------------------------------------
    const availability = await checkAvailability({
      supabase,
      start_date: order.start_date,
      end_date: order.end_date,
      car_model_id: order.car_model_id,
      driver_lang: order.driver_lang,
    });

    if (!availability.ok) {
      console.error("create-payment-intent: availability check failed", availability.error);
      return res.status(500).json({ error: "inventory_check_failed" });
    }

    if (!availability.available) {
      // 不创建 Stripe Session，不返回付款 URL，不发邮件，不改库存，不改订单状态
      return res.status(409).json({
        error: "inventory_unavailable",
        unavailable_dates: availability.unavailable_dates,
      });
    }

    // --------------------
    // 2️⃣ 创建 Stripe Checkout Session（人民币）
    // --------------------
    const deposit = Number(order.deposit_amount || 500);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
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

      // ✅ 手机端支付完成后必须回跳到 Step5
      success_url: `${siteUrl}/booking?step=5&order_id=${encodeURIComponent(order.order_id)}`,
      cancel_url: `${siteUrl}/booking?step=4&order_id=${encodeURIComponent(order.order_id)}`,

      client_reference_id: order.order_id,
      metadata: { order_id: order.order_id },
    });

    // --------------------
    // 3️⃣ 把 Stripe session 写回订单
    // --------------------
    await supabase
      .from("orders")
      .update({
        stripe_session_id: session.id,
        payment_status: "pending",
      })
      .eq("order_id", order.order_id);

    // --------------------
    // 4️⃣ 返回给前端
    // --------------------
    return res.status(200).json({
      url: session.url,
      stripe_session_id: session.id,
      order_id: order.order_id,
    });
  } catch (err) {
    console.error("🔥 create-payment-intent error:", err);
    return res.status(500).json({ error: "Payment intent failed" });
  }
}
