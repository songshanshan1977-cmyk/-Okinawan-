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
  if (order.email_customer_sent) return { skipped: true, reason: "already_sent" };

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

// ====================== ⭐新增：driver_lang 统一成库存用的 ZH / JP ======================
function normalizeDriverLang(lang) {
  const v = String(lang || "ZH").trim().toUpperCase();
  return v === "JP" ? "JP" : "ZH";
}

// ====================== ⭐新增：支付成功后“最终扣库存” ======================
async function finalizeInventoryAfterPaid(order) {
  // 你库存是按：date + car_model_id + driver_lang
  const date = order.start_date;
  const car_model_id = order.car_model_id;
  const driver_lang = normalizeDriverLang(order.driver_lang);

  if (!date || !car_model_id) {
    return { skipped: true, reason: "missing_date_or_model" };
  }

  // 1) 先读出当前库存行
  const { data: inv, error: invErr } = await supabase
    .from("inventory")
    .select("date, car_model_id, driver_lang, total_qty, booked_qty, locked_qty")
    .eq("date", date)
    .eq("car_model_id", car_model_id)
    .eq("driver_lang", driver_lang)
    .maybeSingle();

  if (invErr) return { skipped: true, reason: "inventory_read_failed", error: invErr.message };
  if (!inv) return { skipped: true, reason: "inventory_row_not_found" };

  const bookedNext = (inv.booked_qty || 0) + 1;

  // locked_qty 如果本来就是 0，也不要减成负数（你之前遇到 locked_qty=0 的情况）
  const lockedNow = inv.locked_qty || 0;
  const lockedNext = lockedNow > 0 ? lockedNow - 1 : 0;

  // 2) 写回（最小可用：不依赖 RPC）
  const { error: upInvErr } = await supabase
    .from("inventory")
    .update({ booked_qty: bookedNext, locked_qty: lockedNext })
    .eq("date", date)
    .eq("car_model_id", car_model_id)
    .eq("driver_lang", driver_lang);

  if (upInvErr) return { skipped: true, reason: "inventory_update_failed", error: upInvErr.message };

  return { ok: true, driver_lang, before: inv, after: { booked_qty: bookedNext, locked_qty: lockedNext } };
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

      // ========= ① 读取订单（加上 payment_status 用于幂等） =========
      const { data: order, error: orderErr } = await supabase
        .from("orders")
        .select(
          [
            "order_id",
            "payment_status",
            "start_date",
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
        console.error("load order error:", orderErr?.message || "order not found");
        return res.status(200).json({ ok: true, skipped: "order_not_found" });
      }

      // ========= ② ⭐新增：先把订单推进到 paid（幂等） =========
      let orderPaidResult = { skipped: true, reason: "already_paid" };

      if (order.payment_status !== "paid") {
        const { error: payErr } = await supabase
          .from("orders")
          .update({ payment_status: "paid" })
          .eq("order_id", order.order_id);

        if (payErr) {
          console.error("update order payment_status failed:", payErr.message);
          // 这里不要 throw，避免 Stripe 不断重试导致更乱
          orderPaidResult = { skipped: true, reason: "order_update_failed", error: payErr.message };
        } else {
          orderPaidResult = { ok: true };
        }
      }

      // ========= ③ 你已封板成功的库存锁定逻辑：保持原样（不动） =========
      // ✅ 如果你之前线上真的有 “lock_inventory_v2” 就把原封不动代码放回这里
      // if (!order.inventory_locked) {
      //   await supabase.rpc("lock_inventory_v2", { ... });
      // }

      // ========= ④ ⭐新增：支付成功后“最终扣库存” =========
      // 只在首次 paid 时扣一次（避免重复 webhook 把 booked_qty 加爆）
      let invResult = { skipped: true, reason: "not_first_paid" };
      if (orderPaidResult.ok) {
        invResult = await finalizeInventoryAfterPaid(order);
      }

      // ========= ⑤ 邮件幂等：只发一次（单日 start_date） =========
      const r1 = await sendCustomerEmailOnce(order);
      const r2 = await sendOpsEmailOnce(order);

      return res.status(200).json({
        ok: true,
        event: event.type,
        order_id: orderId,
        order_paid: orderPaidResult,
        inventory: invResult,
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


