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

// =======================
// utils
// =======================
async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function getBaseUrl() {
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  if (site && /^https?:\/\//i.test(site)) return site.replace(/\/$/, "");

  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`.replace(/\/$/, "");

  return "https://okinawan.vercel.app";
}

async function readResponseSafe(resp) {
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {}
  return { text, json };
}

// =======================
// webhook handler
// =======================
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
    /**
     * ==================================================
     * ✅ 主入口（保持不变）：checkout.session.completed
     * ==================================================
     */
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const orderId = session.metadata?.order_id;

      if (!orderId) {
        console.warn("⚠️ checkout.session.completed 但没有 order_id");
        return res.json({ received: true });
      }

      /**
       * 1️⃣ 读取订单
       */
      const { data: order, error: orderErr } = await supabase
        .from("orders")
        .select(
          `
          id,
          order_id,
          status,
          payment_status,
          car_model_id,
          start_date,
          end_date,
          inventory_locked,
          email_status
        `
        )
        .eq("order_id", orderId)
        .single();

      if (orderErr || !order) {
        console.error("❌ 订单不存在:", orderId, orderErr);
        return res.json({ received: true });
      }

      const wasPaid =
        order.payment_status === "paid" || order.status === "paid";

      /**
       * ======================
       * A1：标记订单已支付 + 写 payments（逻辑不动，只去掉 paid_at）
       * ======================
       */
      if (!wasPaid) {
        // ⚠️ 你库里 paid_at 不存在（你截图已经验证过），这里必须去掉
        // 只保留原逻辑的“标记已支付”意图
        const { error: updErr } = await supabase
          .from("orders")
          .update({
            payment_status: "paid",
          })
          .eq("order_id", orderId);

        if (updErr) {
          console.error("❌ A1 更新 orders 失败", orderId, updErr);
        }

        const { error: payErr } = await supabase.from("payments").upsert(
          {
            order_id: orderId,
            stripe_session_id: session.id,
            amount: session.amount_total ?? null,
            currency: session.currency ?? null,
            car_model_id: order.car_model_id,
            paid: true,
          },
          { onConflict: "stripe_session_id" }
        );

        if (payErr) {
          console.error("❌ A1 写 payments 失败", orderId, payErr);
        } else {
          console.log("✅ A1 完成：payment_status=paid + payments 写入", orderId);
        }
      }

      /**
       * ======================
       * A2：库存锁定（幂等）✅ 只修参数：去掉 p_driver_lang
       * ======================
       */
      if (order.inventory_locked !== true) {
        const { error: rpcErr } = await supabase.rpc("increment_locked_qty", {
          p_date: order.start_date,
          p_end_date: order.end_date || order.start_date,
          p_car_model_id: order.car_model_id,
        });

        if (rpcErr) {
          console.error("❌ A2 扣库存 RPC 失败", orderId, rpcErr);
        } else {
          const { error: lockErr } = await supabase
            .from("orders")
            .update({ inventory_locked: true })
            .eq("order_id", orderId);

          if (lockErr) {
            console.error("❌ A2 更新 inventory_locked 失败", orderId, lockErr);
          } else {
            console.log("✅ A2 完成：库存已锁定", {
              order_id: orderId,
              car_model_id: order.car_model_id,
              start_date: order.start_date,
              end_date: order.end_date || order.start_date,
            });
          }
        }
      } else {
        console.log("🔁 A2 幂等命中，已跳过库存扣减", orderId);
      }

      /**
       * ======================
       * B3：确认邮件（保持不变）
       * ======================
       */
      if (!wasPaid && order.email_status !== "sent") {
        try {
          const baseUrl = getBaseUrl();

          const resp = await fetch(`${baseUrl}/api/send-confirmation-email`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order_id: orderId }),
          });

          const { text, json } = await readResponseSafe(resp);

          if (!resp.ok) {
            throw new Error(`B3 non-200 ${resp.status} ${json || text}`);
          }

          console.log("📧 B3 确认邮件已触发", orderId);
        } catch (err) {
          console.error("❌ B3 邮件发送失败", orderId, err);
        }
      }

      /**
       * ======================
       * B0：新订单提醒（保持不变）
       * ======================
       */
      if (!wasPaid) {
        try {
          const baseUrl = getBaseUrl();

          const resp = await fetch(`${baseUrl}/api/send-notify-new-order`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order_id: orderId }),
          });

          const { text, json } = await readResponseSafe(resp);

          if (!resp.ok) {
            throw new Error(`B0 non-200 ${resp.status} ${json || text}`);
          }

          console.log("📩 B0 新订单提醒已触发", orderId);
        } catch (err) {
          console.error("❌ B0 新订单提醒失败", orderId, err);
        }
      }
    }

    /**
     * =========================
     * checkout.session.expired ✅ 只修参数：去掉 p_driver_lang
     * =========================
     */
    if (event.type === "checkout.session.expired") {
      const session = event.data.object;
      const orderId = session.metadata?.order_id || null;

      if (orderId) {
        const { data: order } = await supabase
          .from("orders")
          .select("car_model_id, start_date")
          .eq("order_id", orderId)
          .maybeSingle();

        if (order) {
          const { error: relErr } = await supabase.rpc("release_inventory_lock", {
            p_car_model_id: order.car_model_id,
            p_date: order.start_date,
          });

          if (relErr) {
            console.error("❌ expired 释放库存 RPC 失败", orderId, relErr);
          } else {
            console.log("⏰ 会话过期，库存锁已释放", orderId);
          }
        }
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Webhook 处理异常:", err);
    return res.status(500).send("Internal Server Error");
  }
}

