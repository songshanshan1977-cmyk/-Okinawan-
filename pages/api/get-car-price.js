console.log("🔥🔥🔥 get-car-price DEPLOY CHECK v2025-12-17");
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

  const { data, error } = await supabase
    .from("car_prices")
    .select("price_rmb")
    .eq("car_model_id", car_model_id)
    .eq("driver_lang", driver_lang)
    // ✅ 关键修复在这里 ↓↓↓↓↓↓↓↓↓↓↓↓↓
    .eq("duration_hour", Number(duration_hours))
    // ✅ 数据库字段是 duration_hour（单数）
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    console.error("get-car-price error:", error);
    return res.json({ price: 0, error: "no matched price row" });
  }

  return res.json({
    price: Number(data.price_rmb) || 0,
  });
}


