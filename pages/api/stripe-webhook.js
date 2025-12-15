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
      const metadata = intent.metadata || {};

      const orderId = metadata.order_id;
      const carModelId = metadata.car_model_id;
      const startDate = metadata.start_date;

      if (!orderId || !carModelId || !startDate) {
        console.warn("⚠️ 缺少库存扣减必要字段", metadata);
        return res.json({ received: true });
      }

      console.log("💰 支付成功，订单：", orderId);

      // 1️⃣ 更新订单状态
      await supabase
        .from("orders")
        .update({
          payment_status: "paid",
          paid_at: new Date().toISOString(),
        })
        .eq("order_id", orderId);

      // 2️⃣ 写入 payments 表
      await supabase.from("payments").insert([
        {
          order_id: orderId,
          stripe_session: intent.id,
          amount: intent.amount_received,
          currency: intent.currency,
          car_model_id: carModelId,
          paid: true,
        },
      ]);

      // 3️⃣ ⭐ 库存扣减（只改这里）
      const { data: inventoryRow, error: invErr } = await supabase
        .from("inventory")
        .select("id, stock")
        .eq("car_model_id", carModelId)
        .eq("date", startDate)
        .single();

      if (invErr || !inventoryRow) {
        console.error("❌ 未找到库存记录", carModelId, startDate);
        throw new Error("Inventory not found");
      }

      if (inventoryRow.stock <= 0) {
        console.error("❌ 库存不足，拒绝扣减");
        throw new Error("Out of stock");
      }

      await supabase
        .from("inventory")
        .update({ stock: inventoryRow.stock - 1 })
        .eq("id", inventoryRow.id);

      console.log("📉 库存已扣减", carModelId, startDate);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Webhook 处理异常:", err);
    return res.status(500).send("Internal Server Error");
  }
}

