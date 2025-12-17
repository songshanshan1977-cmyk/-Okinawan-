// pages/api/get-car-price.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ price: 0 });
  }

  const { car_model_id, driver_lang, duration_hours } = req.body;

  if (!car_model_id || !driver_lang || !duration_hours) {
    return res.status(400).json({ price: 0 });
  }

  // ✅【关键修复】：字段名必须是 duration_hour（无 s）
  const { data, error } = await supabase
    .from("car_prices")
    .select("price_rmb")
    .eq("car_model_id", car_model_id)
    .eq("driver_lang", driver_lang)
    .eq("duration_hour", Number(duration_hours)) // ⭐这里！
    .limit(1)
    .single();

  if (error || !data) {
    console.error("get-car-price error:", error);
    return res.json({
      price: 0,
      error: "no matched price row",
    });
  }

  return res.json({
    price: Number(data.price_rmb),
  });
}

