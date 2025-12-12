// pages/api/create-order.js
import { createClient } from "@supabase/supabase-js";

// ⚠️ 必须是 service role
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // 只允许 POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const data = req.body;

    // 最低校验
    if (!data?.order_id || !data?.start_date) {
      return res.status(400).json({
        error: "Missing required fields",
      });
    }

    // 写入 orders 表
    const { data: order, error } = await supabase
      .from("orders")
      .insert([
        {
          order_id: data.order_id,
          car_model: data.car_model,
          driver_lang: data.driver_lang,
          duration: data.duration,
          start_date: data.start_date,
          end_date: data.end_date,
          departure_hotel: data.departure_hotel,
          end_hotel: data.end_hotel,
          name: data.name,
          phone: data.phone,
          email: data.email,
          pax: data.pax,
          luggage: data.luggage,
          total_price: data.total_price,
          payment_status: "unpaid",
          status: "pending",
        },
      ])
      .select()
      .single();

    if (error) {
      console.error("❌ Supabase insert error:", error);
      return res.status(500).json({ error: error.message });
    }

    // ✅ 返回数据库真实订单
    return res.status(200).json({
      success: true,
      data: order,
    });
  } catch (err) {
    console.error("🔥 create-order crash:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}


