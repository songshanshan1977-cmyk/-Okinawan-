// pages/api/stripe-webhook.js

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2022-11-15",
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

const RESEND_FROM =
  process.env.RESEND_FROM || "HonestOki <noreply@xn--okinawa-n14kh45a.com>";

// 读取 raw body
async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ================= 邮件模板（不改逻辑） =================
function buildCustomerEmail(order) {
  const deposit = order.deposit_amount ?? 500;
  const balance =
    order.balance_due ??
    (order.total_price ? order.total_price - deposit : null);

  return {
    subject: `HonestOki 预约确认｜订单 ${order.order_id}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6">
        <h2>预约已确认（押金已支付）</h2>
        <p><b>订单号：</b>${order.order_id}</p>
        <p><b>用车日期：</b>${order.start_date}</p>
        <p><b>车型：</b>${order.car_model_id}</p>
        <p><b>司机语言：</b>${order.driver_lang}</p>
        <p><b>包车时长：</b>${order.duration} 小时</p>
        <hr/>
        <p><b>押金：</b>${deposit} RMB（已支付）</p>
        <p><b>尾款：</b>${
          balance !== null
            ? `${balance} RMB（用车当日支付司机）`
            : "用车当日支付司机"
        }</p>
        <hr/>
        <p>若手机端支付宝未自动跳回，请点击确认单按钮查看。</p>
      </div>
    `,
  };
}

function buildOpsEmail(order) {
  return {
    subject: `【新订单】${order.order_id}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6">
        <p>订单号：${order.order_id}</p>
        <p>日期：${order.start_date}</p>
        <p>车型：${order.car_model_id}</p>
        <p>司机语言：${order.driver_lang}</p>
      </div>
    `,
  };
}

// =============== 邮件幂等（字段不动） ===============
async function sendCustomerEmailOnce(order) {
  if (!order?.email) return;
  if (order.email_customer_sent) return;

  const { data } = await supabase
    .from("orders")
    .update({ email_customer_sent: true })
    .eq("order_id", order.order_id)
    .eq("email_customer_sent", false)
    .select("order_id");

  if (!data || data.length === 0) return;

  const mail = buildCustomerEmail(order);

  try {
    await resend.emails.send({
      from: RESEND_FROM,
      to: order.email,
      subject: mail.subject,
      html: mail.html,
    });
  } catch {
    await supabase
      .from("orders")
      .update({ email_customer_sent: false })
      .eq("order_id", order.order_id);
  }
}

async function sendOpsEmailOnce(order) {
  if (order.email_ops_sent) return;

  const { data } = await supabase
    .from("orders")
    .update({ email_ops_sent: true })
    .eq("order_id", order.order_id)
    .eq("email_ops_sent", false)
    .select("order_id");

  if (!data || data.length === 0) return;

  const mail = buildOpsEmail(order);

  try {
    await resend.emails.send({
      from: RESEND_FROM,
      to: "songshanshan1977@gmail.com",
      subject: mail.subject,
      html: mail.html,
    });
  } catch {
    await supabase
      .from("orders")
      .update({ email_ops_sent: false })
      .eq("order_id", order.order_id);
  }
}

// ================= driver_lang 规范 =================
function normalizeDriverLang(lang) {
  const v = String(lang || "ZH").toUpperCase();
  return v === "JP" ? "JP" : "ZH";
}

// ================= 主 webhook =================
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  let event;

  try {
    const buf = await buffer(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    return res.status(400).send("Webhook Error");
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const orderId =
        session?.metadata?.order_id || session?.client_reference_id;

      if (!orderId) return res.status(200).json({ ok: true });

      // ✅ 关键：inventory_locked 字段已对齐
      const { data: order } = await supabase
        .from("orders")
        .select(
          `
          order_id,
          start_date,
          end_date,
          car_model_id,
          driver_lang,
          duration,
          email,
          total_price,
          deposit_amount,
          balance_due,
          inventory_locked,
          email_customer_sent,
          email_ops_sent
        `
        )
        .eq("order_id", orderId)
        .single();

      if (!order) return res.status(200).json({ ok: true });

      // ✅ 唯一库存幂等判断
      if (!order.inventory_locked) {
        const { error } = await supabase.rpc("lock_inventory_v2", {
          p_start_date: order.start_date,
          p_end_date: order.end_date || order.start_date,
          p_car_model_id: order.car_model_id,
          p_driver_lang: normalizeDriverLang(order.driver_lang),
        });

        if (!error) {
          await supabase
            .from("orders")
            .update({ inventory_locked: true })
            .eq("order_id", order.order_id)
            .eq("inventory_locked", false);
        }
      }

      await sendCustomerEmailOnce(order);
      await sendOpsEmailOnce(order);

      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: true });
  }
}

