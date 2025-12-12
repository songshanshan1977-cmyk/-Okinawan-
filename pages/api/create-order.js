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

    if (!data || !data.order_id) {
      return res.status(400).json({ error: "Missing order_id" });
    }

    const { error, data: inserted } = await supabase
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
          total_price: data.total_price,
          payment_status: "pending",
          status: "created",
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
      order: inserted,
    });
  } catch (err) {
    console.error("❌ create-order exception:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}


