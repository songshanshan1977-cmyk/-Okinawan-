import { createClient } from "@supabase/supabase-js";

/**
 * ✅ 车型 ID → 中文车型（锁死映射，最稳）
 */
function mapCarModelZh(carModelId) {
  const MAP = {
    // ⚠️ 用你系统里真实 UUID（示例）
    "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca": "经济型 5 座",
    "82cf604f-e688-49fe-aecf-69894a01f6cb": "阿尔法 7 座",
    "453df662-d350-4ab9-b811-61ffcda40d4b": "海狮 10 座",
  };

  return MAP[carModelId] || "-";
}

/**
 * ✅ 司机语言 → 中文
 */
function mapDriverLangZh(lang) {
  if (lang === "jp") return "日文司机";
  if (lang === "zh") return "中文司机";
  return "-";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const { order_id } = req.body || {};
    if (!order_id) return res.status(400).json({ error: "order_id is required" });

    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return res.status(500).json({ error: "Missing RESEND_API_KEY" });

    const to = process.env.NOTIFY_TO_EMAIL || "songshanshan1977@gmail.com";
    const from = process.env.NOTIFY_FROM_EMAIL || "onboarding@resend.dev";

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: order, error } = await supabase
      .from("orders")
      .select(`
        order_id,
        start_date,
        end_date,
        car_model_id,
        driver_lang,
        duration,
        name,
        phone,
        email,
        remark,
        total_price,
        departure_hotel,
        end_hotel,
        itinerary
      `)
      .eq("order_id", order_id)
      .single();

    if (error || !order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const carModelZh = mapCarModelZh(order.car_model_id);
    const driverLangZh = mapDriverLangZh(order.driver_lang);

    const subject = `【新订单提醒】${order.order_id} | ${order.start_date || ""}`;

    const text = [
      `✅ 新订单已确认支付（Stripe webhook 已写库）`,
      ``,
      `订单号：${order.order_id}`,
      `用车日期：${order.start_date || "-"} ~ ${order.end_date || order.start_date || "-"}`,
      `出发酒店：${order.departure_hotel || "-"}`,
      `回程酒店：${order.end_hotel || "-"}`,
      `行程：${order.itinerary || "-"}`,
      `车型：${carModelZh}`,
      `司机语言：${driverLangZh}`,
      `时长：${order.duration || "-"}`,
      ``,
      `客人：${order.name || "-"}`,
      `电话：${order.phone || "-"}`,
      `邮箱：${order.email || "-"}`,
      ``,
      `备注：${order.remark || "-"}`,
      `总价：${order.total_price ?? "-"}`,
      ``,
      `（系统自动提醒：仅首次 paid 触发）`,
    ].join("\n");

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, text }),
    });

    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: "Resend failed", details: data });

    return res.status(200).json({ ok: true, id: data.id });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}


