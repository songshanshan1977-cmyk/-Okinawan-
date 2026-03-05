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

// ================= 显示映射（只用于邮件展示） =================
const CAR_MODEL_ID_NAME_MAP = {
  "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca": "经济型 5 座轿车",
  "82cf604f-e688-49fe-aecf-69894a01f6cb": "豪华 7 座阿尔法",
  "453df662-d350-4ab9-b811-61ffcda40d4b": "舒适 10 座海狮",
};

function carNameMap(id) {
  if (!id) return "-";
  if (id === "car1") return "经济型 5 座轿车";
  if (id === "car2") return "豪华 7 座阿尔法";
  if (id === "car3") return "舒适 10 座海狮";
  return CAR_MODEL_ID_NAME_MAP[id] || id;
}

function driverLangMap(lang) {
  const v = String(lang || "").toUpperCase();
  if (v === "ZH" || lang === "zh") return "中文司机";
  if (v === "JP" || lang === "jp") return "日文司机";
  return lang || "-";
}

// ================= 邮件模板（补齐内容） =================
function buildCustomerEmail(order) {
  const deposit = order.deposit_amount ?? 500;
  const balance =
    order.balance_due ??
    (order.total_price ? order.total_price - deposit : null);

  const successUrl = `https://xn--okinawa-n14kh45a.com/success?order_id=${encodeURIComponent(
    order.order_id
  )}`;

  return {
    subject: `HonestOki 预约确认｜订单 ${order.order_id}`,
    html: `
<div style="font-family:Arial,sans-serif;line-height:1.6">
  <h2>预约已确认（押金已支付）</h2>

  <p><b>订单号：</b>${order.order_id ?? "-"}</p>
  <p><b>用车日期：</b>${order.start_date ?? "-"}</p>
  <p><b>车型：</b>${carNameMap(order.car_model_id)}</p>
  <p><b>司机语言：</b>${driverLangMap(order.driver_lang)}</p>
  <p><b>包车时长：</b>${order.duration ?? "-"} 小时</p>

  <p><b>全款：</b>${order.total_price ?? "-"} RMB</p>
  <p><b>押金：</b>${deposit} RMB</p>
  <p><b>尾款：</b>${
    balance !== null
      ? `${balance} RMB（用车当日支付司机）`
      : "用车当日支付司机"
  }</p>

  <hr/>

  <p><b>客人名字：</b>${order.customer_name ?? "-"}</p>
  <p><b>电话：</b>${order.phone ?? "-"}</p>
  <p><b>微信：</b>${order.wechat ?? "-"}</p>
  <p><b>邮箱：</b>${order.email ?? "-"}</p>

  <hr/>

  <p>若手机端支付宝未自动跳回，请点击下方按钮查看确认单（含感谢页内容）。</p>

  <div style="margin-top:18px;text-align:center">
    <a href="${successUrl}"
      style="
        display:inline-block;
        padding:14px 24px;
        background:#2563eb;
        color:#ffffff;
        text-decoration:none;
        border-radius:6px;
        font-size:16px;
        font-weight:bold;
      ">
      查看新订单确认单
    </a>
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

  return {
    subject: `【新订单】${order.order_id}`,
    html: `
<div style="font-family:Arial,sans-serif;line-height:1.6">
  <h3>新订单通知</h3>

  <p><b>订单号：</b>${order.order_id ?? "-"}</p>
  <p><b>用车日期：</b>${order.start_date ?? "-"}</p>
  <p><b>车型：</b>${carNameMap(order.car_model_id)}</p>
  <p><b>司机语言：</b>${driverLangMap(order.driver_lang)}</p>
  <p><b>包车时长：</b>${order.duration ?? "-"} 小时</p>

  <p><b>全款：</b>${order.total_price ?? "-"} RMB</p>
  <p><b>押金：</b>${deposit} RMB</p>
  <p><b>尾款：</b>${balance ?? "-"} RMB</p>

  <hr/>

  <p><b>客人名字：</b>${order.customer_name ?? "-"}</p>
  <p><b>电话：</b>${order.phone ?? "-"}</p>
  <p><b>微信：</b>${order.wechat ?? "-"}</p>
  <p><b>邮箱：</b>${order.email ?? "-"}</p>
</div>
`,
  };
}

// =============== 邮件幂等（不改流程，只加“说实话日志”+ NULL 兼容） ===============
async function sendCustomerEmailOnce(order) {
  console.log("[mail][customer] start", {
    order_id: order?.order_id,
    to: order?.email,
    email_customer_sent: order?.email_customer_sent,
  });

  if (!order?.email) {
    console.log("[mail][customer] skip: no email", { order_id: order?.order_id });
    return;
  }

  if (order.email_customer_sent) {
    console.log("[mail][customer] skip: already sent flag true", {
      order_id: order.order_id,
    });
    return;
  }

  const { data, error } = await supabase
    .from("orders")
    .update({ email_customer_sent: true })
    .eq("order_id", order.order_id)
    // ✅ 关键：兼容 NULL / false，否则很多单 update 匹配不到 → 不触发 resend
    .or("email_customer_sent.is.null,email_customer_sent.eq.false")
    .select("order_id");

  console.log("[mail][customer] flag update result", {
    order_id: order.order_id,
    matched: data?.length || 0,
    error: error?.message || null,
  });

  if (!data || data.length === 0) {
    console.log("[mail][customer] skip: update matched 0 (likely flag not null/false)", {
      order_id: order.order_id,
    });
    return;
  }

  const mail = buildCustomerEmail(order);

  try {
    const resp = await resend.emails.send({
      from: RESEND_FROM,
      to: order.email,
      subject: mail.subject,
      html: mail.html,
      // ✅ 方便你在 Resend 搜索
      tags: [{ name: "order_id", value: String(order.order_id) }],
    });

    console.log("[mail][customer] resend response", {
      order_id: order.order_id,
      resp,
    });
  } catch (err) {
    console.error("[mail][customer] resend ERROR", {
      order_id: order.order_id,
      message: err?.message,
      name: err?.name,
      stack: err?.stack,
    });

    await supabase
      .from("orders")
      .update({ email_customer_sent: false })
      .eq("order_id", order.order_id);
  }
}

async function sendOpsEmailOnce(order) {
  console.log("[mail][ops] start", {
    order_id: order?.order_id,
    email_ops_sent: order?.email_ops_sent,
  });

  if (order.email_ops_sent) {
    console.log("[mail][ops] skip: already sent flag true", { order_id: order.order_id });
    return;
  }

  const { data, error } = await supabase
    .from("orders")
    .update({ email_ops_sent: true })
    .eq("order_id", order.order_id)
    .or("email_ops_sent.is.null,email_ops_sent.eq.false")
    .select("order_id");

  console.log("[mail][ops] flag update result", {
    order_id: order.order_id,
    matched: data?.length || 0,
    error: error?.message || null,
  });

  if (!data || data.length === 0) {
    console.log("[mail][ops] skip: update matched 0", { order_id: order.order_id });
    return;
  }

  const mail = buildOpsEmail(order);

  try {
    const resp = await resend.emails.send({
      from: RESEND_FROM,
      to: "songshanshan1977@gmail.com",
      subject: mail.subject,
      html: mail.html,
      tags: [{ name: "order_id", value: String(order.order_id) }],
    });

    console.log("[mail][ops] resend response", {
      order_id: order.order_id,
      resp,
    });
  } catch (err) {
    console.error("[mail][ops] resend ERROR", {
      order_id: order.order_id,
      message: err?.message,
      name: err?.name,
      stack: err?.stack,
    });

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

      console.log("[webhook] checkout.session.completed", {
        orderId,
        stripe_event_id: event?.id,
      });

      if (!orderId) return res.status(200).json({ ok: true });

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

      if (!order) {
        console.log("[webhook] order not found", { orderId });
        return res.status(200).json({ ok: true });
      }

      if (!order.inventory_locked) {
        const { error } = await supabase.rpc("lock_inventory_v2", {
          p_start_date: order.start_date,
          p_end_date: order.end_date || order.start_date,
          p_car_model_id: order.car_model_id,
          p_driver_lang: normalizeDriverLang(order.driver_lang),
        });

        console.log("[inventory] lock_inventory_v2", {
          order_id: order.order_id,
          error: error?.message || null,
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
    console.error("[webhook] handler ERROR", {
      message: e?.message,
      name: e?.name,
      stack: e?.stack,
    });
    return res.status(200).json({ ok: true });
  }
}
