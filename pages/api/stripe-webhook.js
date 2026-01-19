
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

const OPS_TO = "songshanshan1977@gmail.com";

// ✅ 只用环境变量拿站点域名（用于邮件里的“查看确认单”按钮）
function getSiteUrlFromEnv() {
  const u = (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "").trim();
  return u ? u.replace(/\/$/, "") : "";
}

// 读取 raw body
async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ⭐ 车型 ID → 名称 映射（与你 Step5 一致）
const carIdNameMap = {
  "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca": "经济 5 座轿车",
  "82cf604f-e688-49fe-aecf-69894a01f6cb": "豪华 7 座阿尔法",
  "453df662-d350-4ab9-b811-61ffcda40d4b": "舒适 10 座海狮",
};

// ✅ 司机语言展示：兼容 ZH/JP + zh/jp
function renderDriverLang(v) {
  const x = String(v || "").toUpperCase();
  if (x === "JP") return "日文司机";
  if (x === "ZH") return "中文司机";
  if (String(v || "").toLowerCase() === "jp") return "日文司机";
  if (String(v || "").toLowerCase() === "zh") return "中文司机";
  return "—";
}

// ✅ RPC 入参用的规范化（inventory 是 ZH/JP）
function normalizeDriverLangForRPC(v) {
  const x = String(v || "").trim().toUpperCase();
  return x === "JP" ? "JP" : "ZH";
}

// ===== Step5 同款日期展示 =====
function buildDateText(order) {
  const start = order.start_date;
  const end = order.end_date;

  const isMultiDay = end && end !== start;

  if (!isMultiDay) return start || "—";

  const days =
    Math.floor((new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24)) + 1;

  return `${start} ～ ${end}（共 ${days} 天）`;
}

// ===== 邮件 HTML（尽量与 Step5 一样的信息结构）=====
function buildCustomerEmailHTML(order) {
  const dateText = buildDateText(order);
  const deposit = Number(order.deposit_amount || 500);
  const balance = Math.max((order.total_price || 0) - deposit, 0);

  const contactName =
    order.name || order.contact_name || order.customer_name || "—";
  const contactPhone = order.phone || "—";

  const siteUrl = getSiteUrlFromEnv();
  const confirmLink = siteUrl
    ? `${siteUrl}/booking?step=5&order_id=${encodeURIComponent(order.order_id)}`
    : "";

  return `
  <div style="font-family:Arial,sans-serif;line-height:1.7;max-width:680px;margin:0 auto;color:#111;">
    <h2 style="margin:0 0 8px;">✅ 押金支付成功</h2>
    <p style="margin:0 0 16px;">您的订单已确认，我们已为您锁定车辆，请核对以下信息：</p>

    <div style="border:1px solid #eee;border-radius:10px;padding:18px;">
      <p><b>订单编号：</b>${order.order_id || "—"}</p>
      <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

      <p><b>用车日期：</b>${dateText}</p>
      <p><b>出发酒店：</b>${order.departure_hotel || "—"}</p>
      <p><b>回程酒店：</b>${order.end_hotel || "—"}</p>

      <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

      <p><b>车型：</b>${carIdNameMap[order.car_model_id] || "未选择"}</p>
      ${
        order.itinerary
          ? `<p><b>行程：</b>${order.itinerary}</p>`
          : ``
      }
      <p><b>司机语言：</b>${renderDriverLang(order.driver_lang)}</p>
      <p><b>包车时长：</b>${order.duration ?? "—"} 小时</p>
      <p><b>人数：</b>${order.pax ?? "—"} 人</p>
      <p><b>行李：</b>${order.luggage ?? "—"} 件</p>

      <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

      <p><b>包车总费用：</b>¥${order.total_price ?? "—"}</p>
      <p style="color:#16a34a;font-weight:700;margin:6px 0;">✔ 已支付押金：¥${deposit}</p>
      <p style="color:#f97316;margin:6px 0;">⭐ 尾款（用车当日支付司机）：¥${balance}</p>

      <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

      <p><b>联系人：</b>${contactName}</p>
      <p><b>电话：</b>${contactPhone}</p>
      ${
        order.wechat
          ? `<p><b>微信：</b>${order.wechat}</p>`
          : ``
      }
      <p><b>邮箱：</b>${order.email || "—"}</p>
    </div>

    ${
      confirmLink
        ? `
        <div style="margin:18px 0;">
          <a href="${confirmLink}"
             style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 16px;border-radius:10px;">
            查看确认单（打开 Step5）
          </a>
          <div style="color:#666;font-size:12px;margin-top:8px;">
            ※ 若手机端支付宝未自动跳回，请点击此按钮查看确认单。
          </div>
        </div>
        `
        : ``
    }

    <div style="color:#666;font-size:12px;margin-top:14px;">
      如需修改行程或咨询，请直接回复此邮件。
    </div>
  </div>
  `;
}

function buildOpsEmailHTML(order) {
  const dateText = buildDateText(order);
  const deposit = Number(order.deposit_amount || 500);
  const balance = Math.max((order.total_price || 0) - deposit, 0);

  return `
  <div style="font-family:Arial,sans-serif;line-height:1.7;max-width:680px;margin:0 auto;color:#111;">
    <h2 style="margin:0 0 8px;">📌 新订单提醒（押金已支付）</h2>
    <div style="border:1px solid #eee;border-radius:10px;padding:18px;">
      <p><b>订单编号：</b>${order.order_id || "—"}</p>
      <p><b>用车日期：</b>${dateText}</p>
      <p><b>车型：</b>${carIdNameMap[order.car_model_id] || order.car_model_id || "—"}</p>
      <p><b>司机语言：</b>${renderDriverLang(order.driver_lang)}</p>
      <p><b>时长：</b>${order.duration ?? "—"} 小时</p>
      <p><b>人数：</b>${order.pax ?? "—"} 人</p>
      <p><b>行李：</b>${order.luggage ?? "—"} 件</p>
      <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />
      <p><b>总价：</b>¥${order.total_price ?? "—"}</p>
      <p><b>押金：</b>¥${deposit}</p>
      <p><b>尾款：</b>¥${balance}</p>
      <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />
      <p><b>客户：</b>${order.name || "—"}</p>
      <p><b>电话：</b>${order.phone || "—"}</p>
      <p><b>Email：</b>${order.email || "—"}</p>
      ${order.wechat ? `<p><b>微信：</b>${order.wechat}</p>` : ``}
      ${order.itinerary ? `<p><b>行程：</b>${order.itinerary}</p>` : ``}
      <p><b>出发酒店：</b>${order.departure_hotel || "—"}</p>
      <p><b>回程酒店：</b>${order.end_hotel || "—"}</p>
    </div>
  </div>
  `;
}

// =============== 幂等：只允许“首次”发送（客户） ===============
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

  try {
    await resend.emails.send({
      from: RESEND_FROM,
      to: order.email,
      subject: `HonestOki 预约确认｜订单 ${order.order_id}`,
      html: buildCustomerEmailHTML(order),
    });
    return { ok: true };
  } catch (e) {
    // 失败回滚
    await supabase
      .from("orders")
      .update({ email_customer_sent: false })
      .eq("order_id", order.order_id);

    return { skipped: true, reason: "send_failed", error: e?.message || String(e) };
  }
}

// =============== 幂等：只允许“首次”发送（运营） ===============
async function sendOpsEmailOnce(order) {
  if (order.email_ops_sent) return { skipped: true, reason: "already_sent" };

  const { data: updated, error: upErr } = await supabase
    .from("orders")
    .update({ email_ops_sent: true })
    .eq("order_id", order.order_id)
    .eq("email_ops_sent", false)
    .select("order_id");

  if (upErr) return { skipped: true, reason: "db_update_failed", error: upErr.message };
  if (!updated || updated.length === 0) return { skipped: true, reason: "already_sent_race" };

  try {
    await resend.emails.send({
      from: RESEND_FROM,
      to: OPS_TO,
      subject: `【新订单】${order.order_id}｜${order.start_date || "-"}`,
      html: buildOpsEmailHTML(order),
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
    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({ ok: true, ignored: event.type });
    }

    const session = event.data.object;

    const orderId =
      session?.metadata?.order_id ||
      session?.metadata?.orderId ||
      session?.client_reference_id;

    if (!orderId) {
      console.error("missing orderId in session metadata");
      return res.status(200).json({ ok: true, skipped: "missing_orderId" });
    }

    // ✅ 读订单：字段尽量覆盖 Step5 需要的
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select(
        [
          "order_id",
          "start_date",
          "end_date",
          "departure_hotel",
          "end_hotel",
          "car_model_id",
          "driver_lang",
          "duration",
          "pax",
          "luggage",
          "itinerary",
          "wechat",
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

    // ========= ✅ 付款后扣库存：lock_inventory_v2 → confirm_inventory_v2（只跑一次） =========
    let inventory = { skipped: true, reason: "already_locked" };

    if (!order.inventory_locked) {
      const p_start_date = order.start_date;
      const p_end_date = order.end_date || order.start_date;
      const p_car_model_id = order.car_model_id;
      const p_driver_lang = normalizeDriverLangForRPC(order.driver_lang);

      // 1) 先 lock（带“可用库存检查”）
      const { error: lockErr } = await supabase.rpc("lock_inventory_v2", {
        p_start_date,
        p_end_date,
        p_car_model_id,
        p_driver_lang,
      });

      if (lockErr) {
        console.error("lock_inventory_v2 failed:", lockErr.message);
        inventory = { skipped: true, step: "lock_inventory_v2", error: lockErr.message };
      } else {
        // 2) 再 confirm（真正 booked +1 / locked -1）
        const { error: confirmErr } = await supabase.rpc("confirm_inventory_v2", {
          p_start_date,
          p_end_date,
          p_car_model_id,
          p_driver_lang,
        });

        if (confirmErr) {
          console.error("confirm_inventory_v2 failed:", confirmErr.message);
          inventory = { skipped: true, step: "confirm_inventory_v2", error: confirmErr.message };
        } else {
          // 3) 标记幂等：以后 webhook 重放不再扣
          const { error: markErr } = await supabase
            .from("orders")
            .update({ inventory_locked: true })
            .eq("order_id", order.order_id)
            .eq("inventory_locked", false);

          if (markErr) console.error("mark inventory_locked failed:", markErr.message);

          inventory = { ok: true, driver_lang: p_driver_lang };
        }
      }
    }

    // ========= 邮件：Step5 同款内容 + “查看确认单”按钮（幂等一次） =========
    const email_customer = await sendCustomerEmailOnce(order);
    const email_ops = await sendOpsEmailOnce(order);

    return res.status(200).json({
      ok: true,
      event: event.type,
      order_id: orderId,
      inventory,
      email_customer,
      email_ops,
    });
  } catch (e) {
    console.error("webhook handler error:", e);
    // ✅ 仍然 200，避免 Stripe 重试风暴
    return res.status(200).json({ ok: true, error: String(e?.message || e) });
  }
}
