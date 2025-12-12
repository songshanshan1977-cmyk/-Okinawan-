// pages/api/create-order.js

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const data = req.body;

    if (!data?.order_id) {
      return res.status(400).json({ error: "Missing order_id" });
    }

    // ✅ 所有 NOT NULL 字段做防御校验
    const requiredFields = [
      "car_model_id",
      "duration",
      "pax",
      "luggage",
      "start_date",
      "end_date",
      "departure_hotel",
      "end_hotel",
      "total_price",
    ];

    for (const field of requiredFields) {
      if (data[field] === null || data[field] === undefined) {
        return res.status(400).json({
          error: `Missing required field: ${field}`,
          debug: data,
        });
      }
    }

    const { data: order, error } = await supabase
      .from("orders")
      .insert([
        {
          order_id: data.order_id,
          car_model_id: data.car_model_id,
          driver_lang: data.driver_lang,

          duration: data.duration,        // ✅ 关键修复
          pax: data.pax,                  // ✅
          luggage: data.luggage,          // ✅

          start_date: data.start_date,
          end_date: data.end_date,
          departure_hotel: data.departure_hotel,
          end_hotel: data.end_hotel,

          total_price: data.total_price,
          deposit_amount: data.deposit_amount ?? 500,

          name: data.name,
          phone: data.phone,
          email: data.email,
          remark: data.remark,

          payment_status: "pending",
          inventory_status: "pending",
          email_status: "pending",
          source: data.source || "direct",
        },
      ])
      .select()
      .single();

    if (error) {
      console.error("❌ Supabase insert error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      success: true,
      order,
    });
  } catch (err) {
    console.error("❌ create-order exception:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}


