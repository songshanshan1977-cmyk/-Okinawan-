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

// 押金：人民币 500 元（Stripe 用“分”）
const DEPOSIT_AMOUNT = 50000;

// ✅ 统一回跳域名：优先用 SITE_URL（你刚刚在 Vercel 加的）
// - 支付回跳（success_url / cancel_url）必须和你真实对外域名一致
// - 否则支付宝/微信内置浏览器经常不显示“返回商家”
function getFrontendBaseUrl(req) {
  const siteUrl = (process.env.SITE_URL || "").trim();
  if (siteUrl) return siteUrl.replace(/\/+$/, "");

  const publicUrl = (process.env.NEXT_PUBLIC_SITE_URL || "").trim();
  if (publicUrl) return publicUrl.replace(/\/+$/, "");

  // 最后兜底：根据当前请求 host 拼出来（不推荐，但防止直接挂）
  const host = req?.headers?.host;
  if (host) return `https://${host}`;

  // 如果连 host 都拿不到，就给一个空字符串（Stripe 会报错，便于定位）
  return "";
}

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

    // ✅ 用 order_id 查询订单（只取最新 1 条，避免重复订单）
    const { data: orders, error } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", orderId.trim())
      .order("created_at", { ascending: false })
      .limit(1);

    const order = orders?.[0] ?? null;

    if (error) {
      console.error("❌ 查询 orders 出错：", error);
      return res.status(500).json({ error: "查询订单失败" });
    }

    if (!order) {
      console.warn("⚠️ 未找到订单，order_id =", orderId);
      return res.status(404).json({ error: "订单不存在" });
    }

    // 防止重复支付
    if (order.payment_status === "paid") {
      return res.status(400).json({ error: "订单已支付" });
    }

    /**
     * =================================================
     * ⭐⭐ 最终库存硬校验（最小修复版）
     * =================================================
     */

    // ⭐ 最小兼容：订单里没 driver_lang 时，默认 ZH
    const rawLang = order.driver_lang ?? "ZH";
    const driver_lang =
      String(rawLang).toUpperCase() === "JP" ? "JP" : "ZH";

    const { data: rule, error: ruleError } = await supabase
      .from("inventory_rules_v")
      .select("remaining_qty_calc")
      .eq("date", order.start_date)
      .eq("car_model_id", order.car_model_id)
      .eq("driver_lang", driver_lang)
      .maybeSingle();

    if (ruleError) {
      console.error("❌ inventory_rules_v 查询失败:", ruleError);
      return res.status(500).json({ error: "库存校验失败" });
    }

    const remaining = rule?.remaining_qty_calc ?? 0;

    if (remaining <= 0) {
      console.warn(
        "⛔ 库存不足，阻止创建支付：",
        order.order_id,
        order.car_model_id,
        order.start_date,
        driver_lang
      );
      return res.status(409).json({ error: "库存不足，无法继续支付" });
    }

    // ⭐ webhook / 回跳 / 后续逻辑统一使用 order_id
    const metadata = {
      order_id: order.order_id,
      order_uuid: order.id,
      car_model_id: order.car_model_id,
      start_date: order.start_date,
      end_date: order.end_date,
      driver_lang,
      type: "deposit",
    };

    // ✅ 统一回跳域名（关键）
    const FRONTEND_URL = getFrontendBaseUrl(req);
    if (!FRONTEND_URL) {
      console.error("❌ SITE_URL / NEXT_PUBLIC_SITE_URL 未配置，无法生成回跳地址");
      return res.status(500).json({ error: "站点回跳地址未配置（SITE_URL）" });
    }

    // ⭐ 创建 Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card", "alipay"],

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

      payment_intent_data: {
        metadata,
      },

      metadata,

      // ✅ 支付成功回到 Step5（同域名）
      success_url: `${FRONTEND_URL}/booking?step=5&order_id=${order.order_id}`,

      // ✅ 取消回到 Step4（同域名）
      cancel_url: `${FRONTEND_URL}/booking?step=4&order_id=${order.order_id}&cancel=1`,
    });

    // ⭐⭐ 锁库存（create-payment-intent 阶段）
    await supabase.rpc("lock_inventory", {
      p_car_model_id: order.car_model_id,
      p_date: order.start_date,
      p_driver_lang: driver_lang,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("🔥 create-payment-intent 未捕获异常：", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}


