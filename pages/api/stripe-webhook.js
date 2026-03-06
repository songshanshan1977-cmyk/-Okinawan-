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

// ✅ 手机端按钮要跳到图2（感谢页 / Step5）
const THANK_YOU_URL = (orderId) =>
  `https://okinawan.vercel.app/booking?step=5&order_id=${encodeURIComponent(
    orderId
  )}`;

// ✅ 车型 UUID -> 中文（来自你截图 cars 表）
const CAR_MODEL_ZH_MAP = {
  "453df662-d350-4ab9-b811-61ffcda40d4b": "海狮车型",
  "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca": "经济型轿车",
  "82cf604f-e688-49fe-aecf-69894a01f6cb": "豪华 阿尔法",
};

function getCarModelZh(carModelId) {
  if (!carModelId) return "-";
  return CAR_MODEL_ZH_MAP[carModelId] || carModelId; // 兜底：未知就显示原值
}

function getDriverLangZh(driverLang) {
  const v = String(driverLang || "ZH").toUpperCase();
  return v === "JP" ? "日文司机" : "中文司机";
}

function money(v) {
  if (v === null || v === undefined || v === "") return "-";
  const n = Number(v);
  return Number.isFinite(n) ? `${n} RMB` : `${v} RMB`;
}

// 读取 raw body
async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ================= 邮件模板（只补内容） =================
function buildCustomerEmail(order) {
  const deposit = order.deposit_amount ?? 500;
  const total = order.total_price ?? null;
  const balance =
    order.balance_due ?? (total !== null ? Number(total) - Number(deposit) : null);

  const carZh = getCarModelZh(order.car_model_id);
  const langZh = getDriverLangZh(order.driver_lang);

  const btnUrl = THANK_YOU_URL(order.order_id);

  return {
    subject: `HonestOki 预约确认｜订单 ${order.order_id}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.7;color:#111">
        <h2 style="margin:0 0 12px 0;">预约已确认（押金已支付）</h2>

        <p><b>订单号：</b>${order.order_id || "-"}</p>
        <p><b>用车日期：</b>${order.start_date || "-"}</p>
        <p><b>车型：</b>${carZh}</p>
        <p><b>司机语言：</b>${langZh}</p>
        <p><b>包车时长：</b>${order.duration ? `${order.duration} 小时` : "-"}</p>

        <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

        <p><b>全款：</b>${money(total)}</p>
        <p><b>押金：</b>${money(deposit)}（已支付）</p>
        <p><b>尾款：</b>${
          balance !== null
            ? `${money(balance)}（用车当日支付司机）`
            : "用车当日支付司机"
        }</p>

        <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

        <p><b>客人名字：</b>${order.name || "-"}</p>
        <p><b>电话：</b>${order.phone || "-"}</p>
        <p><b>微信：</b>${order.wechat || "-"}</p>
        <p><b>邮箱：</b>${order.email || "-"}</p>

        <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

        <p>若手机端支付宝未自动跳回，请点击确认单按钮查看。</p>

        <div style="margin-top:14px;">
          <a href="${btnUrl}"
             style="
               display:inline-block;
               padding:12px 18px;
               background:#2f6fec;
               color:#fff;
               text-decoration:none;
               border-radius:8px;
               font-weight:700;
             ">
            查看新订单确认单（感谢页）
          </a>
        </div>

      </div>
    `,
  };
}

function buildOpsEmail(order) {
  const deposit = order.deposit_amount ?? 500;
  const total = order.total_price ?? null;
  const balance =
    order.balance_due ?? (total !== null ? Number(total) - Number(deposit) : null);

  const carZh = getCarModelZh(order.car_model_id);
  const langZh = getDriverLangZh(order.driver_lang);

  return {
    subject: `【新订单】${order.order_id}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.7;color:#111">
        <h2 style="margin:0 0 12px 0;">新订单通知</h2>

        <p><b>订单号：</b>${order.order_id || "-"}</p>
        <p><b>用车日期：</b>${order.start_date || "-"}</p>
        <p><b>车型：</b>${carZh}</p>
        <p><b>司机语言：</b>${langZh}</p>
        <p><b>包车时长：</b>${order.duration ? `${order.duration} 小时` : "-"}</p>

        <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

        <p><b>全款：</b>${money(total)}</p>
        <p><b>押金：</b>${money(deposit)}（已支付）</p>
        <p><b>尾款：</b>${balance !== null ? money(balance) : "-"}</p>

        <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

        <p><b>客人名字：</b>${order.name || "-"}</p>
        <p><b>电话：</b>${order.phone || "-"}</p>
        <p><b>微信：</b>${order.wechat || "-"}</p>
        <p><b>邮箱：</b>${order.email || "-"}</p>
      </div>
    `,
  };
}

// =============== 邮件幂等（不改） ===============
async function sendCustomerEmailOnce(order) {
  console.info("[webhook] sendCustomerEmailOnce start");

  if (!order?.email) {
    console.info("[webhook] sendCustomerEmailOnce skip: no email");
    return;
  }
  if (order.email_customer_sent) {
    console.info("[webhook] sendCustomerEmailOnce skip: already true");
    return;
  }

  const { data, error } = await supabase
    .from("orders")
    .update({ email_customer_sent: true })
    .eq("order_id", order.order_id)
    .eq("email_customer_sent", false)
    .select("order_id");

  if (error) {
    console.info("[webhook] sendCustomerEmailOnce claim error =", error);
    return;
  }
  if (!data || data.length === 0) {
    console.info("[webhook] sendCustomerEmailOnce claim skipped (no rows)");
    return;
  }

  const mail = buildCustomerEmail(order);

  try {
    await resend.emails.send({
      from: RESEND_FROM,
      to: order.email,
      subject: mail.subject,
      html: mail.html,
    });
    console.info("[webhook] sendCustomerEmailOnce done");
  } catch (err) {
    console.info("[webhook] sendCustomerEmailOnce resend error =", err);
    await supabase
      .from("orders")
      .update({ email_customer_sent: false })
      .eq("order_id", order.order_id);
  }
}

async function sendOpsEmailOnce(order) {
  console.info("[webhook] sendOpsEmailOnce start");

  if (order.email_ops_sent) {
    console.info("[webhook] sendOpsEmailOnce skip: already true");
    return;
  }

  const { data, error } = await supabase
    .from("orders")
    .update({ email_ops_sent: true })
    .eq("order_id", order.order_id)
    .eq("email_ops_sent", false)
    .select("order_id");

  if (error) {
    console.info("[webhook] sendOpsEmailOnce claim error =", error);
    return;
  }
  if (!data || data.length === 0) {
    console.info("[webhook] sendOpsEmailOnce claim skipped (no rows)");
    return;
  }

  const mail = buildOpsEmail(order);

  try {
    await resend.emails.send({
      from: RESEND_FROM,
      to: "songshanshan1977@gmail.com",
      subject: mail.subject,
      html: mail.html,
    });
    console.info("[webhook] sendOpsEmailOnce done");
  } catch (err) {
    console.info("[webhook] sendOpsEmailOnce resend error =", err);
    await supabase
      .from("orders")
      .update({ email_ops_sent: false })
      .eq("order_id", order.order_id);
  }
}

// ================= driver_lang 规范（库存用，不改） =================
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

      console.info("[webhook] type =", event.type);
      console.info("[webhook] livemode =", event.livemode);
      console.info("[webhook] SUPABASE_URL =", process.env.NEXT_PUBLIC_SUPABASE_URL);
      console.info("[webhook] RESEND_FROM =", RESEND_FROM);

      const orderId =
        session?.metadata?.order_id || session?.client_reference_id;

      console.info("[webhook] orderId =", orderId);

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
          name,
          phone,
          wechat,
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

      console.info("[webhook] orderErr =", orderErr);
      console.info("[webhook] orderFound =", !!order);

      if (!order) return res.status(200).json({ ok: true });

      console.info("[webhook] email =", order.email);
      console.info("[webhook] email_customer_sent =", order.email_customer_sent);
      console.info("[webhook] email_ops_sent =", order.email_ops_sent);
      console.info("[webhook] inventory_locked =", order.inventory_locked);

      // ✅ 唯一库存幂等判断（不改）
      if (!order.inventory_locked) {
        console.info("[webhook] lock_inventory_v2 start");
        const { error } = await supabase.rpc("lock_inventory_v2", {
          p_start_date: order.start_date,
          p_end_date: order.end_date || order.start_date,
          p_car_model_id: order.car_model_id,
          p_driver_lang: normalizeDriverLang(order.driver_lang),
        });

        console.info("[webhook] lock_inventory_v2 error =", error);

        if (!error) {
          const { error: updErr } = await supabase
            .from("orders")
            .update({ inventory_locked: true })
            .eq("order_id", order.order_id)
            .eq("inventory_locked", false);

          console.info("[webhook] inventory_locked update error =", updErr);
        }
      }

      await sendCustomerEmailOnce(order);
      await sendOpsEmailOnce(order);

      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.info("[webhook] handler catch =", e);
    return res.status(200).json({ ok: true });
  }
}
