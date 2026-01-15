import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

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

    // 1) 先读 orders（把酒店字段也读出来；并加多种可能字段名兜底）
    const { data: order, error: orderErr } = await supabase
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
        pickup_hotel,
        dropoff_hotel,
        start_hotel,
        return_hotel
      `)
      .eq("order_id", order_id)
      .single();

    if (orderErr || !order) {
      return res.status(404).json({ error: "Order not found", details: orderErr || null });
    }

    // 2) 酒店字段：优先按你说的「出发酒店/回程酒店」
    const departureHotel =
      order.departure_hotel ||
      order.pickup_hotel ||
      order.start_hotel ||
      "-";

    const returnHotel =
      order.end_hotel ||
      order.dropoff_hotel ||
      order.return_hotel ||
      "-";

    // 3) 车型中文名：用 car_model_id 去 car_models 查
    let carModelZh = "-";
    if (order.car_model_id) {
      const { data: carModel, error: carErr } = await supabase
        .from("car_models")
        .select("name_zh, title_zh, display_name_zh, name")
        .eq("id", order.car_model_id)
        .maybeSingle();

      if (!carErr && carModel) {
        carModelZh =
          carModel.name_zh ||
          carModel.title_zh ||
          carModel.display_name_zh ||
          carModel.name ||
          "-";
      }
    }

    const subject = `【新订单提醒】${order.order_id} | ${order.start_date || ""}`;

    const text = [
      `✅ 新订单已确认支付（Stripe webhook 已写库）`,
      ``,
      `订单号：${order.order_id}`,
      `用车日期：${order.start_date || "-"} ~ ${order.end_date || order.start_date || "-"}`,
      `出发酒店：${departureHotel}`,
      `回程酒店：${returnHotel}`,
      `车型：${carModelZh}`,
      `司机语言：${order.driver_lang || "-"}`,
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

    return res.status(200).json({ ok: true, id: data.id, carModelZh, departureHotel, returnHotel });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
