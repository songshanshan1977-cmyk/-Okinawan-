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

// ============ helpers ============
async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function normalizeLang(v) {
  const s = String(v || "").trim().toUpperCase();
  if (s === "ZH" || s === "CN" || s === "CH" || s === "中文") return "ZH";
  if (s === "JP" || s === "JA" || s === "JPN" || s === "日文" || s === "日本語")
    return "JP";
  return "ZH";
}

function pickOrderId(session) {
  return (
    session?.metadata?.order_id ||
    session?.metadata?.orderId ||
    session?.client_reference_id
  );
}

async function resendSend({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey) throw new Error("Missing RESEND_API_KEY");
  if (!from) throw new Error("Missing EMAIL_FROM");
  if (!to) throw new Error("Missing recipient");

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.message || data?.error || JSON.stringify(data);
    throw new Error(`Resend send failed: ${resp.status} ${msg}`);
  }
  return data; // { id: ... }
}

function customerEmailTemplate(order) {
  const site = process.env.NEXT_PUBLIC_SITE_URL || "";
  const orderId = order.order_id;
  const date = order.start_date;
  const driverLang = normalizeLang(order.driver_lang);

  return {
    subject: `HonestOki 预约确认｜订单 ${orderId}`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6;">
        <h2>预约已确认（押金已支付）</h2>
        <p>订单号：<b>${orderId}</b></p>
        <p>用车日期：<b>${date}</b></p>
        <p>司机语言：<b>${driverLang}</b></p>
        <p>我们已收到您的押金支付，工作人员将尽快与您确认行程细节。</p>
        <hr/>
        <p style="color:#666;font-size:12px;">
          查看订单：${site ? `<a href="${site}/booking?order_id=${orderId}">${site}/booking?order_id=${orderId}</a>` : "(未设置站点链接)"}
        </p>
      </div>
    `,
  };
}

function opsEmailTemplate(order) {
  const orderId = order.order_id;
  const date = order.start_date;
  const phone = order.phone || "";
  const name = order.name || "";
  const driverLang = normalizeLang(order.driver_lang);

  return {
    subject: `🟢 新订单已支付押金｜${orderId}｜${date}`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6;">
        <h2>新订单提醒（押金已支付）</h2>
        <p>订单号：<b>${orderId}</b></p>
        <p>用车日期：<b>${date}</b></p>
        <p>客户：<b>${name}</b> ${phone ? `（${phone}）` : ""}</p>
        <p>司机语言：<b>${driverLang}</b></p>
        <hr/>
        <p style="color:#666;font-size:12px;">
          请到 Appsmith 中控台进行“确认订单 → 待派单”。
        </p>
      </div>
    `,
  };
}

async function safeUpdateOrder(orderId, patch) {
  // 写库失败不影响主流程（避免因为字段不存在导致 webhook 500）
  try {
    const { error } = await supabase.from("orders").update(patch).eq("order_id", orderId);
    if (error) console.error("⚠️ update order patch failed:", orderId, error);
  } catch (e) {
    console.error("⚠️ update order patch fatal:", orderId, e?.message);
  }
}

// ============ handler ============
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  let event;

  // 1) signature verify
  try {
    const rawBody = await buffer(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("❌ Stripe signature verify failed:", err?.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // only handle checkout.session.completed
    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({ received: true, ignored: event.type });
    }

    const session = event.data.object;
    const orderId = pickOrderId(session);

    if (!orderId) {
      console.error("❌ missing order_id in session metadata");
      return res.status(200).json({ received: true, ok: false, reason: "missing_order_id" });
    }

    // load order
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select(
        "order_id, payment_status, inventory_locked, car_model_id, start_date, end_date, driver_lang, email, name, phone, email_status, ops_email_status"
      )
      .eq("order_id", orderId)
      .maybeSingle();

    if (orderErr) {
      console.error("❌ load order error:", orderErr);
      return res.status(200).json({ received: true, ok: false, error: "load_order_failed", detail: orderErr });
    }
    if (!order) {
      console.error("❌ order not found:", orderId);
      return res.status(200).json({ received: true, ok: false, reason: "order_not_found" });
    }

    // mark paid (idempotent)
    await safeUpdateOrder(orderId, { payment_status: "paid" });

    // 2) inventory lock (idempotent)
    if (order.inventory_locked === true) {
      console.log("✅ inventory already locked, skip. order_id=", orderId);
    } else {
      const startDate = order.start_date;
      const endDate = order.end_date || order.start_date;
      const carModelId = order.car_model_id;
      const driverLang = normalizeLang(order.driver_lang);

      const { error: lockErr } = await supabase.rpc("lock_inventory_v2", {
        p_start_date: startDate,
        p_end_date: endDate,
        p_car_model_id: carModelId,
        p_driver_lang: driverLang,
      });

      if (lockErr) {
        console.error("❌ A2 扣库存 RPC 失败", orderId, lockErr);
        // 不让 Stripe 重试（返回 200）
        return res.status(200).json({
          received: true,
          ok: false,
          error: "lock_inventory_failed",
          detail: lockErr,
        });
      }

      await safeUpdateOrder(orderId, { inventory_locked: true });
    }

    // 3) send emails (idempotent)
    // 3-1 customer confirmation
    if (String(order.email_status || "").toLowerCase() === "sent") {
      console.log("✅ customer email already sent, skip. order_id=", orderId);
    } else {
      try {
        const tpl = customerEmailTemplate(order);
        await resendSend({
          to: order.email,
          subject: tpl.subject,
          html: tpl.html,
        });
        await safeUpdateOrder(orderId, { email_status: "sent", email_sent_at: new Date().toISOString() });
        console.log("✅ customer email sent. order_id=", orderId);
      } catch (e) {
        console.error("❌ customer email failed:", orderId, e?.message);
        await safeUpdateOrder(orderId, { email_status: "failed", email_error: String(e?.message || e) });
        // 邮件失败也不阻断 webhook
      }
    }

    // 3-2 ops new order notification
    const opsTo = "songshanshan1977@gmail.com";
    if (String(order.ops_email_status || "").toLowerCase() === "sent") {
      console.log("✅ ops email already sent, skip. order_id=", orderId);
    } else {
      try {
        const tpl = opsEmailTemplate(order);
        await resendSend({
          to: opsTo,
          subject: tpl.subject,
          html: tpl.html,
        });
        await safeUpdateOrder(orderId, { ops_email_status: "sent", ops_email_sent_at: new Date().toISOString() });
        console.log("✅ ops email sent. order_id=", orderId);
      } catch (e) {
        console.error("❌ ops email failed:", orderId, e?.message);
        await safeUpdateOrder(orderId, { ops_email_status: "failed", ops_email_error: String(e?.message || e) });
      }
    }

    return res.status(200).json({ received: true, ok: true });
  } catch (err) {
    console.error("❌ webhook handler fatal error:", err);
    // 不让 Stripe 重试风暴
    return res.status(200).json({ received: true, ok: false, error: "handler_fatal", message: err?.message });
  }
}

