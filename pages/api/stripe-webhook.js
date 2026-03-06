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

// ✅ 你图1 的感谢页（手机端按钮要打开这里）
const THANK_YOU_URL =
  process.env.PUBLIC_THANK_YOU_URL ||
  "https://xn--okinawa-n14kh45a.com/success?order_id=";

// 读取 raw body
async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ================= 显示映射（只影响邮件展示） =================

// ✅ 车型 UUID -> 中文（把剩下两个 UUID 补上就全中文了）
const CAR_MODEL_ID_NAME_MAP = {
  // 你截图里的这个 UUID（ORD-20260305-33072）
  "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca": "经济型轿车（5座）",

  // TODO: 把你数据库 car_models 里另外两台车的 UUID 填进来：
  // "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx": "豪华阿尔法（7座）",
  // "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy": "10座海狮（Hiace）",
};

function carNameZh(id) {
  if (!id) return "";
  // 兼容老的 car1/car2/car3
  if (id === "car1") return "经济型轿车（5座）";
  if (id === "car2") return "豪华阿尔法（7座）";
  if (id === "car3") return "10座海狮（Hiace）";
  // UUID 映射
  return CAR_MODEL_ID_NAME_MAP[id] || id; // 没填映射就会显示原值（避免报错）
}

function driverLangZh(lang) {
  const v = String(lang || "").toUpperCase();
  if (v === "JP") return "日文司机";
  if (v === "ZH") return "中文司机";
  return lang || "";
}

function safe(v) {
  return v === null || v === undefined ? "" : String(v);
}

function money(v) {
  if (v === null || v === undefined || v === "") return "";
  return `${v} RMB`;
}

// ================= 邮件模板（只补内容，不改流程） =================

function buildCustomerEmail(order) {
  const deposit = order.deposit_amount ?? 500;
  const balance =
    order.balance_due ??
    (order.total_price ? order.total_price - deposit : null);

  const total = order.total_price ?? "";

  const btnUrl = `${THANK_YOU_URL}${encodeURIComponent(order.order_id)}`;

  return {
    subject: `HonestOki 预约确认｜订单 ${order.order_id}`,
    html: `
<div style="font-family:Arial,sans-serif;line-height:1.75;color:#111">
  <h2 style="margin:0 0 12px 0;">预约已确认（押金已支付）</h2>

  <div style="background:#f6f7f9;border:1px solid #e5e7eb;border-radius:10px;padding:14px 14px;margin:12px 0;">
    <p style="margin:6px 0;"><b>订单号：</b>${safe(order.order_id)}</p>
    <p style="margin:6px 0;"><b>用车日期：</b>${safe(order.start_date)}</p>
    <p style="margin:6px 0;"><b>车型：</b>${safe(carNameZh(order.car_model_id))}</p>
    <p style="margin:6px 0;"><b>司机语言：</b>${safe(driverLangZh(order.driver_lang))}</p>
    <p style="margin:6px 0;"><b>包车时长：</b>${safe(order.duration)} 小时</p>
  </div>

  <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 14px;margin:12px 0;">
    <p style="margin:6px 0;"><b>全款：</b>${money(total)}</p>
    <p style="margin:6px 0;"><b>押金：</b>${money(deposit)}（已支付）</p>
    <p style="margin:6px 0;"><b>尾款：</b>${
      balance !== null
        ? `${money(balance)}（用车当日支付司机）`
        : "用车当日支付司机"
    }</p>
  </div>

  <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 14px;margin:12px 0;">
    <p style="margin:6px 0;"><b>客人名字：</b>${safe(order.customer_name)}</p>
    <p style="margin:6px 0;"><b>电话：</b>${safe(order.phone)}</p>
    <p style="margin:6px 0;"><b>微信：</b>${safe(order.wechat)}</p>
    <p style="margin:6px 0;"><b>邮箱：</b>${safe(order.email)}</p>
  </div>

  <p style="margin:14px 0 10px 0;">若手机端支付宝未自动跳回，请点击确认单按钮查看。</p>

  <!-- ✅ 手机端按钮：打开感谢页（图1） -->
  <div style="margin:18px 0;">
    <a href="${btnUrl}"
       style="display:inline-block;padding:14px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:10px;font-size:16px;">
      打开确认单 / 感谢页
    </a>
  </div>

  <div style="color:#6b7280;font-size:12px;margin-top:18px;">
    本邮件由系统自动发送，请勿直接回复。
  </div>
</div>
`,
  };
}

function buildOpsEmail(order) {
  const deposit = order.deposit_amount ?? 500;
  const balance =
    order.balance_due ??
    (order.total_price ? order.total_price - deposit : null);

  const total = order.total_price ?? "";

  const btnUrl = `${THANK_YOU_URL}${encodeURIComponent(order.order_id)}`;

  return {
    subject: `【新订单】${order.order_id}`,
    html: `
<div style="font-family:Arial,sans-serif;line-height:1.75;color:#111">
  <h3 style="margin:0 0 10px 0;">新订单通知</h3>

  <p style="margin:6px 0;"><b>订单号：</b>${safe(order.order_id)}</p>
  <p style="margin:6px 0;"><b>用车日期：</b>${safe(order.start_date)}</p>
  <p style="margin:6px 0;"><b>车型：</b>${safe(carNameZh(order.car_model_id))}</p>
  <p style="margin:6px 0;"><b>司机语言：</b>${safe(driverLangZh(order.driver_lang))}</p>
  <p style="margin:6px 0;"><b>包车时长：</b>${safe(order.duration)} 小时</p>

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0;" />

  <p style="margin:6px 0;"><b>全款：</b>${money(total)}</p>
  <p style="margin:6px 0;"><b>押金：</b>${money(deposit)}</p>
  <p style="margin:6px 0;"><b>尾款：</b>${balance !== null ? money(balance) : ""}</p>

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0;" />

  <p style="margin:6px 0;"><b>客人名字：</b>${safe(order.customer_name)}</p>
  <p style="margin:6px 0;"><b>电话：</b>${safe(order.phone)}</p>
  <p style="margin:6px 0;"><b>微信：</b>${safe(order.wechat)}</p>
  <p style="margin:6px 0;"><b>邮箱：</b>${safe(order.email)}</p>

  <div style="margin:16px 0;">
    <a href="${btnUrl}"
       style="display:inline-block;padding:12px 16px;background:#111827;color:#fff;text-decoration:none;border-radius:10px;font-size:14px;">
      打开确认单 / 感谢页
    </a>
  </div>
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

// ================= 主 webhook（保留你现在能跑通的逻辑） =================
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  let event;

  try {
    const buf = await buffer(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.log("[webhook] signature verify failed:", err?.message || err);
    return res.status(400).send("Webhook Error");
  }

  try {
    console.log("[webhook] type =", event?.type);
    console.log("[webhook] livemode =", event?.livemode);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const orderId =
        session?.metadata?.order_id || session?.client_reference_id;

      console.log("[webhook] orderId =", orderId);
      console.log(
        "[webhook] SUPABASE_URL =",
        process.env.NEXT_PUBLIC_SUPABASE_URL
      );
      console.log("[webhook] RESEND_FROM =", RESEND_FROM);

      if (!orderId) return res.status(200).json({ ok: true });

      // ✅ 只为邮件展示补字段：customer_name/phone/wechat（不改其它逻辑）
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
          customer_name,
          phone,
          wechat,
          inventory_locked,
          email_customer_sent,
          email_ops_sent
        `
        )
        .eq("order_id", orderId)
        .single();

      console.log("[webhook] orderErr =", orderErr);
      console.log("[webhook] orderFound =", !!order);

      if (!order) return res.status(200).json({ ok: true });

      console.log("[webhook] email =", order.email);
      console.log("[webhook] email_customer_sent =", order.email_customer_sent);
      console.log("[webhook] email_ops_sent =", order.email_ops_sent);
      console.log("[webhook] inventory_locked =", order.inventory_locked);

      // ✅ 唯一库存幂等判断
      if (!order.inventory_locked) {
        console.log("[webhook] lock_inventory_v2 start");
        const { error: lockErr } = await supabase.rpc("lock_inventory_v2", {
          p_start_date: order.start_date,
          p_end_date: order.end_date || order.start_date,
          p_car_model_id: order.car_model_id,
          p_driver_lang: normalizeDriverLang(order.driver_lang),
        });
        console.log("[webhook] lock_inventory_v2 error =", lockErr);

        if (!lockErr) {
          const { error: invUpdErr } = await supabase
            .from("orders")
            .update({ inventory_locked: true })
            .eq("order_id", order.order_id)
            .eq("inventory_locked", false);
          console.log("[webhook] inventory_locked update error =", invUpdErr);
        }
      }

      console.log("[webhook] sendCustomerEmailOnce start");
      await sendCustomerEmailOnce(order);
      console.log("[webhook] sendCustomerEmailOnce done");

      console.log("[webhook] sendOpsEmailOnce start");
      await sendOpsEmailOnce(order);
      console.log("[webhook] sendOpsEmailOnce done");

      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.log("[webhook] handler error:", e?.message || e);
    return res.status(200).json({ ok: true });
  }
}
