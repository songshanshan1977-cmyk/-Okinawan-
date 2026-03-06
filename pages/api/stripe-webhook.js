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

// ========== 工具 ==========
async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function fmtMoney(v) {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : String(v);
}

function carNameZh(id) {
  const map = {
    "453df662-d350-4ab9-b811-61ffcda40d4b": "海狮车型",
    "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca": "经济型轿车",
    "82cf604f-e688-49fe-aecf-69894a01f6cb": "丰田阿尔法德",
  };
  return map[id] || safeStr(id) || "包车车型";
}

function driverLangZh(lang) {
  const v = String(lang || "ZH").toUpperCase();
  return v === "JP" ? "日文司机" : "中文司机";
}

function normalizeDriverLang(lang) {
  const v = String(lang || "ZH").toUpperCase();
  return v === "JP" ? "JP" : "ZH";
}

// ========== 邮件模板（只影响内容） ==========
function buildCustomerEmail(order) {
  const deposit = order.deposit_amount ?? 500;
  const balance =
    order.balance_due ??
    (order.total_price ? Number(order.total_price) - Number(deposit) : null);

  const successUrl = `https://xn--okinawa-n14kh45a.com/success?order_id=${encodeURIComponent(
    order.order_id
  )}`;

  return {
    subject: `HonestOki 预约确认｜订单 ${order.order_id}`,
    html: `
<div style="font-family:Arial,sans-serif;line-height:1.7;color:#111">
  <h2 style="margin:0 0 12px 0;">预约已确认（押金已支付）</h2>

  <p><b>订单号：</b>${safeStr(order.order_id)}</p>
  <p><b>用车日期：</b>${safeStr(order.start_date)}</p>
  <p><b>车型：</b>${carNameZh(order.car_model_id)}</p>
  <p><b>司机语言：</b>${driverLangZh(order.driver_lang)}</p>
  <p><b>包车时长：</b>${safeStr(order.duration)} 小时</p>

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:14px 0;" />

  <p><b>全款：</b>${fmtMoney(order.total_price)} RMB</p>
  <p><b>押金：</b>${fmtMoney(deposit)} RMB（已支付）</p>
  <p><b>尾款：</b>${
    balance !== null
      ? `${fmtMoney(balance)} RMB（用车当日支付司机）`
      : "用车当日支付司机"
  }</p>

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:14px 0;" />

  <p><b>客人名字：</b>${safeStr(order.name)}</p>
  <p><b>电话：</b>${safeStr(order.phone)}</p>
  <p><b>微信：</b>${safeStr(order.wechat)}</p>
  <p><b>邮箱：</b>${safeStr(order.email)}</p>

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:14px 0;" />

  <p style="margin:0 0 14px 0;">若手机端支付宝未自动跳回，请点击确认单按钮查看。</p>

  <a href="${successUrl}"
     style="display:inline-block;padding:12px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;font-size:16px;">
    查看新订单确认单（感谢页）
  </a>
</div>
    `,
  };
}

function buildOpsEmail(order) {
  const deposit = order.deposit_amount ?? 500;
  const balance =
    order.balance_due ??
    (order.total_price ? Number(order.total_price) - Number(deposit) : null);

  return {
    subject: `【新订单】${order.order_id}`,
    html: `
<div style="font-family:Arial,sans-serif;line-height:1.7;color:#111">
  <h3 style="margin:0 0 12px 0;">新订单邮件确认</h3>

  <p><b>订单号：</b>${safeStr(order.order_id)}</p>
  <p><b>用车日期：</b>${safeStr(order.start_date)}</p>
  <p><b>车型：</b>${carNameZh(order.car_model_id)}</p>
  <p><b>司机语言：</b>${driverLangZh(order.driver_lang)}</p>
  <p><b>包车时长：</b>${safeStr(order.duration)} 小时</p>

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:14px 0;" />

  <p><b>全款：</b>${fmtMoney(order.total_price)} RMB</p>
  <p><b>押金：</b>${fmtMoney(deposit)} RMB</p>
  <p><b>尾款：</b>${balance !== null ? `${fmtMoney(balance)} RMB` : ""}</p>

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:14px 0;" />

  <p><b>客人名字：</b>${safeStr(order.name)}</p>
  <p><b>电话：</b>${safeStr(order.phone)}</p>
  <p><b>微信：</b>${safeStr(order.wechat)}</p>
  <p><b>邮箱：</b>${safeStr(order.email)}</p>
</div>
    `,
  };
}

// ========== 幂等发送（逻辑不变，只加日志） ==========
async function sendCustomerEmailOnce(order) {
  console.log("[webhook] sendCustomerEmailOnce start");

  if (!order?.email) {
    console.log("[webhook] sendCustomerEmailOnce skip: no email");
    return;
  }
  if (order.email_customer_sent) {
    console.log("[webhook] sendCustomerEmailOnce skip: already true");
    return;
  }

  const { data, error } = await supabase
    .from("orders")
    .update({ email_customer_sent: true })
    .eq("order_id", order.order_id)
    .eq("email_customer_sent", false)
    .select("order_id");

  console.log("[webhook] email_customer_sent update error =", error || null);
  console.log("[webhook] email_customer_sent update rows =", data?.length || 0);

  if (!data || data.length === 0) return;

  const mail = buildCustomerEmail(order);

  try {
    const r = await resend.emails.send({
      from: RESEND_FROM,
      to: order.email,
      subject: mail.subject,
      html: mail.html,
    });
    console.log("[webhook] resend customer ok =", r?.id || "no-id");
  } catch (e) {
    console.log("[webhook] resend customer FAILED =", e?.message || e);

    await supabase
      .from("orders")
      .update({ email_customer_sent: false })
      .eq("order_id", order.order_id);

    console.log("[webhook] rollback email_customer_sent to false");
  }

  console.log("[webhook] sendCustomerEmailOnce done");
}

async function sendOpsEmailOnce(order) {
  console.log("[webhook] sendOpsEmailOnce start");

  if (order.email_ops_sent) {
    console.log("[webhook] sendOpsEmailOnce skip: already true");
    return;
  }

  const { data, error } = await supabase
    .from("orders")
    .update({ email_ops_sent: true })
    .eq("order_id", order.order_id)
    .eq("email_ops_sent", false)
    .select("order_id");

  console.log("[webhook] email_ops_sent update error =", error || null);
  console.log("[webhook] email_ops_sent update rows =", data?.length || 0);

  if (!data || data.length === 0) return;

  const mail = buildOpsEmail(order);

  try {
    const r = await resend.emails.send({
      from: RESEND_FROM,
      to: "songshanshan1977@gmail.com",
      subject: mail.subject,
      html: mail.html,
    });
    console.log("[webhook] resend ops ok =", r?.id || "no-id");
  } catch (e) {
    console.log("[webhook] resend ops FAILED =", e?.message || e);

    await supabase
      .from("orders")
      .update({ email_ops_sent: false })
      .eq("order_id", order.order_id);

    console.log("[webhook] rollback email_ops_sent to false");
  }

  console.log("[webhook] sendOpsEmailOnce done");
}

// ========== 主 webhook ==========
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  let event;

  try {
    const buf = await buffer(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.log("[webhook] constructEvent FAILED =", err?.message || err);
    return res.status(400).send("Webhook Error");
  }

  try {
    console.log("[webhook] type =", event.type);
    console.log("[webhook] livemode =", !!event.livemode);
    console.log("[webhook] SUPABASE_URL =", process.env.NEXT_PUBLIC_SUPABASE_URL);
    console.log("[webhook] RESEND_FROM =", RESEND_FROM);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const orderId =
        session?.metadata?.order_id || session?.client_reference_id;

      console.log("[webhook] orderId =", orderId || null);

      if (!orderId) return res.status(200).json({ ok: true });

      const { data: order, error: orderErr } = await supabase
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
          email_ops_sent,
          name,
          phone,
          wechat
        `
        )
        .eq("order_id", orderId)
        .single();

      console.log("[webhook] orderErr =", orderErr || null);
      console.log("[webhook] orderFound =", !!order);

      if (!order) return res.status(200).json({ ok: true });

      console.log("[webhook] email =", order.email || null);
      console.log("[webhook] email_customer_sent =", !!order.email_customer_sent);
      console.log("[webhook] email_ops_sent =", !!order.email_ops_sent);
      console.log("[webhook] inventory_locked =", !!order.inventory_locked);

      // 库存锁
      if (!order.inventory_locked) {
        console.log("[webhook] lock_inventory_v2 start");

        const { error } = await supabase.rpc("lock_inventory_v2", {
          p_start_date: order.start_date,
          p_end_date: order.end_date || order.start_date,
          p_car_model_id: order.car_model_id,
          p_driver_lang: normalizeDriverLang(order.driver_lang),
        });

        console.log("[webhook] lock_inventory_v2 error =", error || null);

        if (!error) {
          const { error: updErr } = await supabase
            .from("orders")
            .update({ inventory_locked: true })
            .eq("order_id", order.order_id)
            .eq("inventory_locked", false);

          console.log("[webhook] inventory_locked update error =", updErr || null);
        }
      }

      await sendCustomerEmailOnce(order);
      await sendOpsEmailOnce(order);

      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.log("[webhook] handler CATCH =", e?.message || e);
    return res.status(200).json({ ok: true });
  }
}
