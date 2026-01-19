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
  process.env.RESEND_FROM ||
  "HonestOki <noreply@xn--okinawa-n14kh45a.com>";

// ================= raw body =================
async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ================= 工具 =================
function normalizeDriverLang(lang) {
  const v = String(lang || "").toUpperCase();
  return v === "JP" ? "JP" : "ZH";
}

// ================= 邮件模板 =================
function buildCustomerEmail(order, siteUrl) {
  const deposit = order.deposit_amount ?? 500;
  const balance =
    order.total_price != null ? order.total_price - deposit : null;

  const step5Url = `${siteUrl}/booking?step=5&order_id=${encodeURIComponent(
    order.order_id
  )}`;

  return {
    subject: `HonestOki 预约确认｜订单 ${order.order_id}`,
    html: `
<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;">
  <h2>✅ 押金支付成功｜订单已确认</h2>

  <p><b>订单编号：</b>${order.order_id}</p>
  <p><b>用车日期：</b>${order.start_date}</p>
  <p><b>车型：</b>${order.car_model_id}</p>
  <p><b>司机语言：</b>${order.driver_lang}</p>
  <p><b>包车时长：</b>${order.duration} 小时</p>

  <hr/>

  <p><b>包车总费用：</b>¥${order.total_price}</p>
  <p style="color:#16a34a;font-weight:700;">✔ 已支付押金：¥${deposit}</p>
  <p style="color:#ea580c;">
    ⭐ 尾款（用车当日支付司机）：¥${balance}
  </p>

  <hr/>

  <p><b>联系人：</b>${order.name || "-"}</p>
  <p><b>电话：</b>${order.phone || "-"}</p>
  <p><b>微信：</b>${order.wechat || "-"}</p>
  <p><b>邮箱：</b>${order.email || "-"}</p>

  <div style="margin:20px 0;">
    <a href="${step5Url}"
       style="display:inline-block;background:#111827;color:#fff;
              padding:12px 18px;border-radius:8px;
              text-decoration:none;font-weight:700;">
      查看确认单（打开 Step5）
    </a>
  </div>

  <!-- ✅【关键改动：不再让客人“回复邮件”】【只引导点黑色按钮】 -->
  <div style="margin-top:14px;padding:12px;
              border:1px solid #e5e7eb;border-radius:10px;
              background:#fafafa;">
    <div style="font-weight:700;margin-bottom:6px;">
      ✅ 订单确认与售后支持
    </div>

    <div style="line-height:1.6;">
      若手机端 <b>支付宝支付后未自动跳回</b>，
      请点击上方 <b>黑色按钮「查看确认单（打开 Step5）」</b> 查看订单详情。
      <br/>
      售后咨询 / 修改行程，请在确认单页面内联系
      <b>微信 / WhatsApp 客服</b>。
    </div>

    <div style="color:#6b7280;font-size:12px;margin-top:8px;">
      ※ 本邮件为系统通知邮件，请以确认单页面客服为准。
    </div>
  </div>
</div>
`,
  };
}

function buildOpsEmail(order) {
  return {
    subject: `【新订单】${order.order_id}`,
    html: `
<div style="font-family:Arial,sans-serif;line-height:1.6">
  <h2>新订单已支付押金</h2>
  <p><b>订单号：</b>${order.order_id}</p>
  <p><b>日期：</b>${order.start_date}</p>
  <p><b>车型：</b>${order.car_model_id}</p>
  <p><b>司机语言：</b>${order.driver_lang}</p>
  <p><b>时长：</b>${order.duration} 小时</p>

  <hr/>

  <p><b>客户：</b>${order.name}</p>
  <p><b>电话：</b>${order.phone}</p>
  <p><b>微信：</b>${order.wechat || "-"}</p>
  <p><b>Email：</b>${order.email}</p>
</div>
`,
  };
}

// ================= 邮件幂等 =================
async function sendCustomerEmailOnce(order, siteUrl) {
  if (!order.email || order.email_customer_sent) return;

  const { data } = await supabase
    .from("orders")
    .update({ email_customer_sent: true })
    .eq("order_id", order.order_id)
    .eq("email_customer_sent", false)
    .select("order_id");

  if (!data || data.length === 0) return;

  const mail = buildCustomerEmail(order, siteUrl);

  try {
    await resend.emails.send({
      from: RESEND_FROM,
      to: order.email,
      subject: mail.subject,
      html: mail.html,
    });
  } catch (e) {
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
  } catch (e) {
    await supabase
      .from("orders")
      .update({ email_ops_sent: false })
      .eq("order_id", order.order_id);
  }
}

// ================= webhook 主逻辑 =================
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  let event;
  try {
    const buf = await buffer(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    return res.status(400).send("Webhook signature verification failed.");
  }

  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({ ok: true });
  }

  const session = event.data.object;
  const orderId =
    session?.metadata?.order_id || session?.client_reference_id;

  if (!orderId) return res.status(200).json({ ok: true });

  const { data: order } = await supabase
    .from("orders")
    .select("*")
    .eq("order_id", orderId)
    .single();

  if (!order) return res.status(200).json({ ok: true });

  // ✅ 支付成功 → 确认库存（你已经有的函数）
  if (!order.inventory_confirmed) {
    await supabase.rpc("confirm_inventory_v21", {
      p_car_model_id: order.car_model_id,
      p_start_date: order.start_date,
      p_end_date: order.end_date || order.start_date,
      p_driver_lang: normalizeDriverLang(order.driver_lang),
    });

    await supabase
      .from("orders")
      .update({ inventory_confirmed: true })
      .eq("order_id", order.order_id);
  }

  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL || "https://xn--okinawa-n14kh45a.com";

  await sendCustomerEmailOnce(order, siteUrl);
  await sendOpsEmailOnce(order);

  return res.status(200).json({ ok: true });
}

