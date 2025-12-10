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

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
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
    console.error("❌ Webhook 签名验证失败：", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const orderId = session.metadata?.orderId;

      console.log("✅ Webhook 收到成功支付，订单：", orderId);

      // 1）更新订单状态
      await supabase
        .from("orders")
        .update({ status: "paid", paid_at: new Date().toISOString() })
        .eq("order_id", orderId);

      // 2）扣库存（Supabase RPC）
      await supabase.rpc("decrement_inventory", {
        p_car_model_id: session.metadata.car_model_id,
        p_date: session.metadata.start_date,
      });

      // 3）写入 payments 表
      await supabase.from("payments").insert([
        {
          order_id: orderId,
          stripe_session_id: session.id,
          amount: session.amount_total,
          currency: session.currency,
          status: "paid",
        },
      ]);

      // 4）发送确认邮件
      await supabase.functions.invoke("send-confirmation-email", {
        body: { order_id: orderId },
      });
    }

    return res.json({ received: true });

  } catch (err) {
    console.error("❌ Webhook 处理异常：", err);
    return res.status(500).send("Internal Server Error");
  }
}
