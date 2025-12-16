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
    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object;

      let orderId = intent.metadata?.order_id || null;
      let carModelId = intent.metadata?.car_model_id || null;
      let startDate = intent.metadata?.start_date || null;

      // ✅ 兼容 metadata 在 charge 上的情况
      if (!orderId && intent.latest_charge) {
        const charge = await stripe.charges.retrieve(intent.latest_charge);
        if (charge?.metadata) {
          orderId = charge.metadata.order_id || orderId;
          carModelId = charge.metadata.car_model_id || carModelId;
          startDate = charge.metadata.start_date || startDate;
        }
      }

      if (!orderId) {
        console.warn("⚠️ payment_intent.succeeded 但没有 order_id");
        return res.json({ received: true });
      }

      // ① 读取订单（判断是否已锁库存）
      const { data: order, error: orderError } = await supabase
        .from("orders")
        .select("inventory_locked")
        .eq("order_id", orderId)
        .maybeSingle();

      if (orderError) {
        console.error("❌ 读取订单失败:", orderError);
        throw orderError;
      }

      // ② 更新订单支付状态
      await supabase
        .from("orders")
        .update({
          payment_status: "paid",
          paid_at: new Date().toISOString(),
        })
        .eq("order_id", orderId);

      // ③ 防重复写 payments
      const { data: existingPayment } = await supabase
        .from("payments")
        .select("id")
        .eq("stripe_session_id", intent.id)
        .maybeSingle();

      if (!existingPayment) {
        await supabase.from("payments").insert([
          {
            order_id: orderId,
            stripe_session_id: intent.id,
            amount: intent.amount_received,
            currency: intent.currency,
            car_model_id: carModelId,
            paid: true,
          },
        ]);
      }

      // ④ 库存扣减（只执行一次）
      if (!order?.inventory_locked && carModelId && startDate) {
        // 先查库存
        const { data: inventory, error: inventoryError } = await supabase
          .from("inventory")
          .select("id, stock")
          .eq("car_model_id", carModelId)
          .eq("date", startDate)
          .single();

        if (inventoryError || !inventory) {
          console.error("❌ 找不到库存记录:", inventoryError);
          throw inventoryError;
        }

        if (inventory.stock <= 0) {
          console.error("❌ 库存不足，阻止扣减");
          return res.json({ received: true });
        }

        // 扣库存（明确 -1）
        const { error: updateError } = await supabase
          .from("inventory")
          .update({ stock: inventory.stock - 1 })
          .eq("id", inventory.id);

        if (updateError) {
          console.error("❌ 扣库存失败:", updateError);
          throw updateError;
        }

        // 锁定订单，防止重复扣
        await supabase
          .from("orders")
          .update({ inventory_locked: true })
          .eq("order_id", orderId);

        console.log(
          "🔒 库存已扣减并锁定订单:",
          orderId,
          "剩余 stock:",
          inventory.stock - 1
        );

        // 📩 邮件暂时保留（不作为 webhook 成功条件）
        try {
          await fetch(
            `${process.env.NEXT_PUBLIC_SITE_URL}/api/send-confirmation-email`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ order_id: orderId }),
            }
          );
          console.log("📧 已触发确认邮件:", orderId);
        } catch (mailErr) {
          console.error("⚠️ 触发确认邮件失败:", mailErr);
        }
      }
    }

    if (event.type === "checkout.session.completed") {
      console.log("📦 checkout 完成:", event.data.object.id);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Webhook 处理异常:", err);
    return res.status(500).send("Internal Server Error");
  }
}

