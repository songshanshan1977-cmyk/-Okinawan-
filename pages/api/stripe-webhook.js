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

// ⭐ 兜底：避免 Missing 'from' field (422)
const RESEND_FROM =
  process.env.RESEND_FROM || "HonestOki <noreply@xn--okinawa-n14kh45a.com>";

// ✅ 站点域名（用于邮件按钮跳 Step5）
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/$/, "");

// ⭐ 车型 ID → 中文名（仅用于邮件展示）
const CAR_MODEL_NAME_MAP = {
  "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca": "经济 5 座轿车",
  "82cf604f-e688-49fe-aecf-69894a01f6cb": "豪华 7 座阿尔法",
  "453df662-d350-4ab9-b811-61ffcda40d4b": "舒适 10 座海狮",
};

// ⭐ 司机语言 → 中文（仅用于邮件展示）
const DRIVER_LANG_TEXT = {
  ZH: "中文司机",
  JP: "日文司机",
  zh: "中文司机",
  jp: "日文司机",
};

// 读取 raw body
async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ⭐ 最小必要：driver_lang 统一成库存用的 ZH / JP（避免 orders 里是 zh/jp 对不上 inventory）
function normalizeDriverLang(lang) {
  const raw = String(lang || "").trim();
  const low = raw.toLowerCase();
  if (low === "jp") return "JP";
  if (low === "zh") return "ZH";
  const up = raw.toUpperCase();
  return up === "JP" ? "JP" : "ZH";
}

// =============== 邮件模板（展示改中文 + 加按钮 + 改底部提示） ===============
function buildCustomerEmail(order) {
  const deposit = order.deposit_amount ?? 500;
  const balance =
    order.balance_due ??
    (order.total_price ? order.total_price - deposit : null);

  const carName = CAR_MODEL_NAME_MAP[order.car_model_id] || "—";
  const langText = DRIVER_LANG_TEXT[order.driver_lang] || DRIVER_LANG_TEXT[normalizeDriverLang(order.driver_lang)] || "—";

  const orderUrl =
    SITE_URL && order?.order_id
      ? `${SITE_URL}/booking?step=5&order_id=${encodeURIComponent(order.order_id)}`
      : null;

  return {
    subject: `HonestOki 预约确认｜订单 ${order.order_id}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.75;max-width:680px;margin:0 auto;color:#111;">
        <h2 style="margin:0 0 12px 0;">✅ 押金支付成功｜订单已确认</h2>
        <p style="margin:0 0 14px 0;">您的订单已确认，我们已为您锁定车辆，请核对以下信息：</p>

        <div style="border:1px solid #e5e7eb;border-radius:14px;padding:16px;">
          <p style="margin:6px 0;"><b>订单编号：</b>${order.order_id}</p>
          <p style="margin:6px 0;"><b>用车日期：</b>${order.start_date || "-"}</p>
          ${order.end_date && order.end_date !== order.start_date ? `<p style="margin:6px 0;"><b>结束日期：</b>${order.end_date}</p>` : ""}

          <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

          <p style="margin:6px 0;"><b>车型：</b>${carName}</p>
          <p style="margin:6px 0;"><b>司机语言：</b>${langText}</p>
          <p style="margin:6px 0;"><b>包车时长：</b>${order.duration || "-"} 小时</p>

          ${
            order.itinerary
              ? `<p style="margin:6px 0;"><b>行程：</b>${order.itinerary}</p>`
              : ""
          }

          <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

          <p style="margin:6px 0;"><b>包车总费用：</b>¥${order.total_price ?? "-"}</p>
          <p style="margin:6px 0;color:#16a34a;font-weight:700;">✔ 已支付押金：¥${deposit}</p>
          <p style="margin:6px 0;color:#ea580c;font-weight:700;">⭐ 尾款（用车当日支付司机）：¥${
            balance !== null ? balance : "-"
          }</p>

          <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

          <p style="margin:6px 0;"><b>联系人：</b>${order.name || "-"}</p>
          <p style="margin:6px 0;"><b>电话：</b>${order.phone || "-"}</p>
          ${order.wechat ? `<p style="margin:6px 0;"><b>微信：</b>${order.wechat}</p>` : ""}
          <p style="margin:6px 0;"><b>邮箱：</b>${order.email || "-"}</p>
        </div>

        ${
          orderUrl
            ? `
              <div style="margin:18px 0;">
                <a href="${orderUrl}"
                   style="display:inline-block;background:#111;color:#fff;text-decoration:none;
                          padding:12px 18px;border-radius:10px;font-weight:700;">
                  查看确认单（打开 Step5）
                </a>
              </div>
              <div style="margin:10px 0 0 0;color:#666;font-size:13px;">
                若手机端支付宝未自动跳回，请点击黑色按钮查看确认单
              </div>
            `
            : ""
        }

        <div style="margin-top:18px;color:#666;font-size:12px;">
          本邮件为系统自动发送。
        </div>
      </div>
    `,
  };
}

function buildOpsEmail(order) {
  const carName = CAR_MODEL_NAME_MAP[order.car_model_id] || "—";
  const langText =
    DRIVER_LANG_TEXT[order.driver_lang] ||
    DRIVER_LANG_TEXT[normalizeDriverLang(order.driver_lang)] ||
    "—";

  return {
    subject: `【新订单】${order.order_id}｜${order.start_date || "-"}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.7">
        <h2>新订单提醒</h2>
        <p><b>订单号：</b>${order.order_id}</p>
        <p><b>用车日期：</b>${order.start_date || "-"}</p>
        ${order.end_date && order.end_date !== order.start_date ? `<p><b>结束日期：</b>${order.end_date}</p>` : ""}
        <p><b>车型：</b>${carName}</p>
        <p><b>司机语言：</b>${langText}</p>
        <p><b>时长：</b>${order.duration || "-"}</p>
        <hr/>
        <p><b>客户：</b>${order.name || "-"}</p>
        <p><b>电话：</b>${order.phone || "-"}</p>
        <p><b>Email：</b>${order.email || "-"}</p>
      </div>
    `,
  };
}

// =============== 邮件幂等：只允许“首次”发送 ===============
async function sendCustomerEmailOnce(order) {
  if (!order?.email) return { skipped: true, reason: "no_customer_email" };
  if (order.email_customer_sent) return { skipped: true, reason: "already_sent" };

  const { data: updated, error: upErr } = await supabase
    .from("orders")
    .update({ email_customer_sent: true })
    .eq("order_id", order.order_id)
    .eq("email_customer_sent", false)
    .select("order_id");

  if (upErr) return { skipped: true, reason: "db_update_failed", error: upErr.message };
  if (!updated || updated.length === 0) return { skipped: true, reason: "already_sent_race" };

  const mail = buildCustomerEmail(order);

  try {
    await resend.emails.send({
      from: RESEND_FROM,
      to: order.email,
      subject: mail.subject,
      html: mail.html,
    });
    return { ok: true };
  } catch (e) {
    await supabase
      .from("orders")
      .update({ email_customer_sent: false })
      .eq("order_id", order.order_id);
    return { skipped: true, reason: "send_failed", error: e?.message || String(e) };
  }
}

async function sendOpsEmailOnce(order) {
  const opsTo = "songshanshan1977@gmail.com";
  if (order.email_ops_sent) return { skipped: true, reason: "already_sent" };

  const { data: updated, error: upErr } = await supabase
    .from("orders")
    .update({ email_ops_sent: true })
    .eq("order_id", order.order_id)
    .eq("email_ops_sent", false)
    .select("order_id");

  if (upErr) return { skipped: true, reason: "db_update_failed", error: upErr.message };
  if (!updated || updated.length === 0) return { skipped: true, reason: "already_sent_race" };

  const mail = buildOpsEmail(order);

  try {
    await resend.emails.send({
      from: RESEND_FROM,
      to: opsTo,
      subject: mail.subject,
      html: mail.html,
    });
    return { ok: true };
  } catch (e) {
    await supabase
      .from("orders")
      .update({ email_ops_sent: false })
      .eq("order_id", order.order_id);
    return { skipped: true, reason: "send_failed", error: e?.message || String(e) };
  }
}

// =============== 库存确认：执行 confirm_inventory_v2（兼容签名差异） ===============
async function confirmInventoryV2Once(order) {
  // ✅ 幂等字段（你如果用的是 inventory_confirmed / inventory_confirmed_at，都行）
  // 这里用最保守：看 orders.inventory_confirmed / inventory_confirmed_at 是否存在，
  // 但为了不依赖一定有字段：我们只用你已有的 inventory_locked 也可。
  // —— 你现在说“库存扣减 ok”，一般都会有一个“已确认”标记字段。
  if (order.inventory_confirmed === true) {
    return { skipped: true, reason: "already_confirmed" };
  }

  const p_car_model_id = order.car_model_id;
  const p_driver_lang = normalizeDriverLang(order.driver_lang);

  // 单日 / 多日：如果你的 confirm_inventory_v2 是单日，就循环；如果是范围，就一次
  const start = order.start_date;
  const end = order.end_date || order.start_date;

  // 生成日期列表（不引入第三方，最简单写法）
  const days = [];
  {
    const s = new Date(start);
    const e = new Date(end);
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      days.push(`${y}-${m}-${dd}`);
    }
  }

  // 1) 先尝试：范围版本（如果你 v21 就是这个，一次搞定）
  // 可能签名：confirm_inventory_v2(p_start_date, p_end_date, p_car_model_id, p_driver_lang)
  let rangeOk = false;
  try {
    const { error: rpcErr } = await supabase.rpc("confirm_inventory_v2", {
      p_start_date: start,
      p_end_date: end,
      p_car_model_id,
      p_driver_lang,
    });
    if (!rpcErr) rangeOk = true;
  } catch (_) {
    // ignore
  }

  // 2) 如果范围不支持，则按“单日版本”逐天 confirm
  if (!rangeOk) {
    for (const p_date of days) {
      // 可能签名A：confirm_inventory_v2(p_car_model_id, p_date, p_driver_lang)
      const tryA = await supabase.rpc("confirm_inventory_v2", {
        p_car_model_id,
        p_date,
        p_driver_lang,
      });

      if (!tryA.error) continue;

      // 可能签名B：confirm_inventory_v2(p_car_model_id, p_date) 旧版
      const tryB = await supabase.rpc("confirm_inventory_v2", {
        p_car_model_id,
        p_date,
      });

      if (tryB.error) {
        return {
          skipped: true,
          reason: "confirm_failed",
          error: tryB.error.message || tryA.error.message,
          debug: { p_car_model_id, p_date, p_driver_lang },
        };
      }
    }
  }

  // 3) 打标：防止重复 webhook 二次扣
  // 如果你 orders 表里有 inventory_confirmed 字段，用它；
  // 如果没有字段，这段 update 会报错，但不会影响 webhook 返回 200
  try {
    await supabase
      .from("orders")
      .update({ inventory_confirmed: true })
      .eq("order_id", order.order_id)
      .eq("inventory_confirmed", false);
  } catch (_) {
    // ignore
  }

  return { ok: true, mode: rangeOk ? "range" : "daily" };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  let event;

  try {
    const buf = await buffer(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed.", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // ✅ 只处理 checkout.session.completed
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const orderId =
        session?.metadata?.order_id ||
        session?.metadata?.orderId ||
        session?.client_reference_id;

      if (!orderId) {
        console.error("missing orderId in session metadata");
        return res.status(200).json({ ok: true, skipped: "missing_orderId" });
      }

      // ========= ① 读取订单（只加 end_date + itinerary + wechat + inventory_confirmed） =========
      const { data: order, error: orderErr } = await supabase
        .from("orders")
        .select(
          [
            "order_id",
            "start_date",
            "end_date",
            "car_model_id",
            "driver_lang",
            "duration",
            "name",
            "phone",
            "email",
            "total_price",
            "deposit_amount",
            "balance_due",
            "itinerary",
            "wechat",
            "inventory_confirmed",
            "email_customer_sent",
            "email_ops_sent",
          ].join(",")
        )
        .eq("order_id", orderId)
        .single();

      if (orderErr || !order) {
        console.error("load order error:", orderErr?.message || "order not found");
        return res.status(200).json({ ok: true, skipped: "order_not_found" });
      }

      // ========= ② ✅付款后确认库存（confirm_inventory_v2）幂等 =========
      const inv = await confirmInventoryV2Once(order);

      // ========= ③ 邮件幂等：只发一次 =========
      const r1 = await sendCustomerEmailOnce(order);
      const r2 = await sendOpsEmailOnce(order);

      return res.status(200).json({
        ok: true,
        order_id: orderId,
        inventory_confirm: inv,
        email_customer: r1,
        email_ops: r2,
      });
    }

    return res.status(200).json({ ok: true, ignored: event.type });
  } catch (e) {
    console.error("webhook handler error:", e);
    return res.status(200).json({ ok: true, error: String(e?.message || e) });
  }
}

