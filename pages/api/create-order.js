// pages/api/create-order.js

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ⭐ 车型 ID 映射（必须是 UUID）
const CAR_MODEL_IDS = {
  car1: "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca",
  car2: "82cf604f-e688-49fe-aecf-69894a01f6cb",
  car3: "453df662-d350-4ab9-b811-61ffcda40d4b",
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const data = req.body;

    if (!data?.order_id) {
      return res.status(400).json({ error: "Missing order_id" });
    }

    const carModelUUID = CAR_MODEL_IDS[data.car_model];

    if (!carModelUUID) {
      return res.status(400).json({
        error: `Invalid car_model: ${data.car_model}`,
      });
    }

    const { data: inserted, error } = await supabase
      .from("orders")
      .insert([
        {
          order_id: data.order_id,
          car_model_id: carModelUUID, // ✅ UUID
          driver_lang: data.driver_lang,
          duration: data.duration,
          start_date: data.start_date,
          end_date: data.end_date,
          departure_hotel: data.departure_hotel,
          end_hotel: data.end_hotel,
          total_price: data.total_price,
          deposit_amount: 500,
          name: data.name,
          phone: data.phone,
          email: data.email,
          remark: data.remark || null,
          status: "created",
          payment_status: "pending",
          inventory_status: "pending",
          email_status: "pending",
          balance_paid: false,
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




