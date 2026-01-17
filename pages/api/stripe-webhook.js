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
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

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
     * ✅ 原定：唯一入口 checkout.session.completed
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
       * 1️⃣ 读取订单（字段对齐：payment_status / inventory_locked / email_status）
       * 兼容：老字段 status / email_status
       */
      const { data: order, error: orderErr } = await supabase
        .from("orders")
        .select(
          `
          id,
          order_id,
          payment_status,
          status,
          car_model_id,
          start_date,
          end_date,
          driver_lang,
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

      // ✅ 以 payment_status 为准；没有的话兼容 status
      const currentPaidFlag =
        (order.payment_status && order.payment_status === "paid") ||
        (order.status && order.status === "paid");

      /**
       * ======================
       * A1：标记订单已支付 + 写 payments
       * ======================
       */
      if (!currentPaidFlag) {
        // 1) 更新订单支付状态（⚠️ 不写 paid_at，因为你库里没有这个列）
        const { error: updErr } = await supabase
          .from("orders")
          .update({
            payment_status: "paid", // ✅ 你生产库字段
            // status: "paid",       // 不强行写，避免你库没有 status
          })
          .eq("order_id", orderId);

        if (updErr) {
          console.error("❌ A1 orders.update 失败:", orderId, updErr);
          return res.json({ received: true });
        }

        // 2) 写 payments（保持你原逻辑：stripe_session_id 去重）
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
          console.error("❌ A1 payments.upsert 失败:", orderId, payErr);
          // 不中断主流程也行，但我建议你先中断，避免“看起来成功其实没写进去”
          return res.json({ received: true });
        }

        console.log("✅ A1 完成：订单 payment_status=paid + payments 写入", orderId);
      } else {
        console.log("🔁 A1 跳过：已是 paid", orderId);
      }

      /**
       * ======================
       * A2：库存锁定（幂等，多日不改逻辑）
       * ======================
       */
      if (order.inventory_locked !== true) {
        const { error: rpcErr } = await supabase.rpc("increment_locked_qty", {
          p_date: order.start_date,
          p_end_date: order.end_date || order.start_date,
          p_car_model_id: order.car_model_id,
          p_driver_lang: order.driver_lang, // ✅ 你现在库存按 driver_lang 维度
        });

        if (rpcErr) {
          console.error("❌ A2 increment_locked_qty 失败:", orderId, rpcErr);
          return res.json({ received: true });
        }

        const { error: lockErr } = await supabase
          .from("orders")
          .update({ inventory_locked: true })
          .eq("order_id", orderId);

        if (lockErr) {
          console.error("❌ A2 orders.inventory_locked 写回失败:", orderId, lockErr);
          return res.json({ received: true });
        }

        console.log("✅ A2 完成：库存已锁定", {
          order_id: orderId,
          car_model_id: order.car_model_id,
          driver_lang: order.driver_lang,
          start_date: order.start_date,
          end_date: order.end_date || order.start_date,
        });
      } else {
        console.log("🔁 A2 幂等命中，跳过库存扣减", orderId);
      }

      /**
       * ======================
       * B3：确认邮件（只在第一次 paid）
       * ======================
       */
      if (!currentPaidFlag && order.email_status !== "sent") {
        try {
          const baseUrl = getBaseUrl();
          const resp = await fetch(`${baseUrl}/api/send-confirmation-email`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order_id: orderId }),
          });

          const { text, json } = await readResponseSafe(resp);
          if (!resp.ok) {
            console.error("❌ B3 非200:", { order_id: orderId, status: resp.status, body: json || text });
            throw new Error(`B3 non-200 ${resp.status}`);
          }

          console.log("📧 B3 确认邮件已触发", orderId);
        } catch (err) {
          console.error("❌ B3 邮件发送失败", orderId, err?.message || err);
        }
      } else {
        console.log("🔁 B3 跳过：非首次 paid 或 email_status=sent", orderId);
      }

      /**
       * ======================
       * B0：新订单提醒（你日志里看到它 500，这是另一个接口问题）
       * 这里保持原逻辑：失败不影响主链路
       * ======================
       */
      if (!currentPaidFlag) {
        try {
          const baseUrl = getBaseUrl();
          const resp = await fetch(`${baseUrl}/api/send-notify-new-order`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order_id: orderId }),
          });

          const { text, json } = await readResponseSafe(resp);
          if (!resp.ok) {
            console.error("❌ B0 非200:", { order_id: orderId, status: resp.status, body: json || text });
            throw new Error(`B0 non-200 ${resp.status}`);
          }

          console.log("📩 B0 新订单提醒已触发", orderId);
        } catch (err) {
          console.error("❌ B0 新订单提醒失败", orderId, err?.message || err);
        }
      }
    }

    /**
     * =========================
     * checkout.session.expired
     * =========================
     */
    if (event.type === "checkout.session.expired") {
      const session = event.data.object;
      const orderId = session.metadata?.order_id || null;

      if (orderId) {
        const { data: order } = await supabase
          .from("orders")
          .select("car_model_id, start_date, driver_lang")
          .eq("order_id", orderId)
          .maybeSingle();

        if (order) {
          const { error: relErr } = await supabase.rpc("release_inventory_lock", {
            p_car_model_id: order.car_model_id,
            p_date: order.start_date,
            p_driver_lang: order.driver_lang,
          });

          if (relErr) {
            console.error("❌ expired release_inventory_lock 失败:", orderId, relErr);
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

