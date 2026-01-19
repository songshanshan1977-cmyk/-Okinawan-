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

// 读取 raw body
async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// =============== 邮件模板（单日：只用 start_date） ===============
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
        <p><b>用车日期：</b>${order.start_date || "-"}</p>
        <p><b>车型ID：</b>${order.car_model_id || "-"}</p>
        <p><b>司机语言：</b>${order.driver_lang || "-"}</p>
        <p><b>时长：</b>${order.duration || "-"}</p>
        <hr/>
        <p><b>押金：</b>${deposit} RMB（已支付）</p>
        <p><b>尾款：</b>${
          balance !== null
            ? `${balance} RMB（用车当日支付司机）`
            : "用车当日支付司机"
        }</p>
        <hr/>
        <p>如需修改行程或咨询，请直接回复此邮件。</p>
      </div>
    `,
  };
}

function buildOpsEmail(order) {
  return {
    subject: `【新订单】${order.order_id}｜${order.start_date || "-"}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6">
        <h2>新订单提醒</h2>
        <p><b>订单号：</b>${order.order_id}</p>
        <p><b>用车日期：</b>${order.start_date || "-"}</p>
        <p><b>车型ID：</b>${order.car_model_id || "-"}</p>
        <p><b>司机语言：</b>${order.driver_lang || "-"}</p>
        <p><b>时长：</b>${order.duration || "-"}</p>
        <hr/>
        <p><b>客户：</b>${order.name || "-"}</p>
        <p><b>电话：</b>${order.phone || "-"}</p>
        <p><b>Email：</b>${order.email || "-"}</p>
      </div>
    `,
  };
}

// =============== 幂等：只允许“首次”发送 ===============
async function sendCustomerEmailOnce(order) {
  if (!order?.email) return { skipped: true, reason: "no_customer_email" };
  if (order.email_customer_sent)
    return { skipped: true, reason: "already_sent" };

  // 先抢占：把 false -> true（并发/重复 webhook 时可防重复）
  const { data: updated, error: upErr } = await supabase
    .from("orders")
    .update({ email_customer_sent: true })
    .eq("order_id", order.order_id)
    .eq("email_customer_sent", false)
    .select("order_id");

  if (upErr) {
    return { skipped: true, reason: "db_update_failed", error: upErr.message };
  }
  if (!updated || updated.length === 0) {
    return { skipped: true, reason: "already_sent_race" };
  }

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
    // 发送失败回滚，避免“锁死”
    await supabase
      .from("orders")
      .update({ email_customer_sent: false })
      .eq("order_id", order.order_id);
    return {
      skipped: true,
      reason: "send_failed",
      error: e?.message || String(e),
    };
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

  if (upErr)
    return { skipped: true, reason: "db_update_failed", error: upErr.message };
  if (!updated || updated.length === 0)
    return { skipped: true, reason: "already_sent_race" };

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
    return {
      skipped: true,
      reason: "send_failed",
      error: e?.message || String(e),
    };
  }
}

// ⭐ 最小必要：driver_lang 统一成库存用的 ZH / JP（避免 orders 里是 zh/jp 导致对不上 inventory）
function normalizeDriverLang(lang) {
  const v = String(lang || "ZH").trim().toUpperCase();
  return v === "JP" ? "JP" : "ZH";
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

      // ========= ① 读取订单（只加 end_date 用于 lock_inventory_v2） =========
      const { data: order, error: orderErr } = await supabase
        .from("orders")
        .select(
          [
            "order_id",
            "start_date",
            "end_date", // ✅ 仅为 lock_inventory_v2 参数
            "car_model_id",
            "driver_lang",
            "duration",
            "name",
            "phone",
            "email",
            "total_price",
            "deposit_amount",
            "balance_due",
            "inventory_locked",
            "email_customer_sent",
            "email_ops_sent",
          ].join(",")
        )
        .eq("order_id", orderId)
        .single();

      if (orderErr || !order) {
        console.error(
          "load order error:",
          orderErr?.message || "order not found"
        );
        return res.status(200).json({ ok: true, skipped: "order_not_found" });
      }

      // ========= ② ✅执行 lock_inventory_v2（仅把注释变成真执行，幂等靠 inventory_locked） =========
      let invLock = { skipped: true, reason: "already_locked" };

      if (!order.inventory_locked) {
        const p_start_date = order.start_date;
        const p_end_date = order.end_date || order.start_date; // 单日兜底
        const p_car_model_id = order.car_model_id;
        const p_driver_lang = normalizeDriverLang(order.driver_lang);

        const { error: rpcErr } = await supabase.rpc("lock_inventory_v2", {
          p_start_date,
          p_end_date,
          p_car_model_id,
          p_driver_lang,
        });

        if (rpcErr) {
          console.error("lock_inventory_v2 failed:", rpcErr.message);
          // 仍返回 200，避免 Stripe 重试风暴
          invLock = {
            skipped: true,
            reason: "lock_failed",
            error: rpcErr.message,
          };
        } else {
          // ✅ 标记已锁，保证幂等（下一次 webhook 直接跳过）
          const { error: markErr } = await supabase
            .from("orders")
            .update({ inventory_locked: true })
            .eq("order_id", order.order_id)
            .eq("inventory_locked", false);

          if (markErr) {
            console.error("mark inventory_locked failed:", markErr.message);
          }

          invLock = { ok: true };
        }
      }

      // ========= ③ 邮件幂等：只发一次 =========
      const r1 = await sendCustomerEmailOnce(order);
      const r2 = await sendOpsEmailOnce(order);

      return res.status(200).json({
        ok: true,
        order_id: orderId,
        inventory_lock: invLock,
        email_customer: r1,
        email_ops: r2,
      });
    }

    return res.status(200).json({ ok: true, ignored: event.type });
  } catch (e) {
    console.error("webhook handler error:", e);
    return res
      .status(200)
      .json({ ok: true, error: String(e?.message || e) });
  }
}

