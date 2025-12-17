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

  // 基础校验
  if (!car_model_id || !driver_lang || !duration_hours) {
    return res.json({
      price: 0,
      error: "missing params",
      received: req.body,
    });
  }

  // 🔴 核心：查 car_prices
  const { data, error } = await supabase
    .from("car_prices")
    .select("price_rmb")
    .eq("car_model_id", car_model_id)
    .eq("driver_lang", driver_lang)
    .eq("duration_hours", Number(duration_hours))
    .limit(1)
    .maybeSingle(); // ⚠️ 不要用 single，避免 406

  if (error) {
    console.error("❌ get-car-price error:", error);
    return res.json({
      price: 0,
      error: error.message,
    });
  }

  if (!data) {
    return res.json({
      price: 0,
      error: "no matched price row",
    });
  }

  // ✅ 成功
  return res.json({
    price: Number(data.price_rmb),
  });
}
