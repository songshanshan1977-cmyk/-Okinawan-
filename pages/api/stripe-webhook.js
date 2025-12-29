// pages/api/stripe-webhook.js

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2022-11-15",
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 读取 raw body
async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const sig = req.headers["stripe-signature"];
  const buf = await buffer(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error("❌ Webhook 签名校验失败:", err.message);
    return res.status(400).send("Webhook Error");
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const orderId = session.metadata?.order_id;

      if (!orderId) {
        console.warn("⚠️ checkout.session.completed 但没有 order_id");
        return res.json({ received: true });
      }

      const { data: order } = await supabase
        .from("orders")
        .select("status, car_model_id, date, inventory_locked")
        .eq("order_id", orderId)
        .single();

      // ===== A1：订单已支付 =====
      if (order.status !== "paid") {
        // 🔑 关键：从 PaymentIntent 取真实金额
        const paymentIntent = await stripe.paymentIntents.retrieve(
          session.payment_intent
        );

        await supabase
          .from("orders")
          .update({
            status: "paid",
            paid_at: new Date().toISOString(),
          })
          .eq("order_id", orderId);

        await supabase.from("payments").insert({
          order_id: orderId,
          stripe_session_id: session.id,
          amount: paymentIntent.amount_received,
          currency: paymentIntent.currency,
        });

        console.log("✅ A1 完成：orders + payments 写入", orderId);
      }

      // ===== A2：库存锁定 =====
      if (order.inventory_locked !== true) {
        await supabase.rpc("increment_locked_qty", {
          p_date: order.date,
          p_car_model_id: order.car_model_id,
        });

        await supabase
          .from("orders")
          .update({ inventory_locked: true })
          .eq("order_id", orderId);

        console.log("✅ A2 完成：库存 locked_qty +1", orderId);
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Webhook 处理异常:", err);
    return res.status(500).send("Internal Server Error");
  }
}

