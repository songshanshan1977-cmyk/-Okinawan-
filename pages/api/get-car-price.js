// pages/api/get-car-price.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ price: 0, error: "POST only" });
  }

  let { car_model_id, driver_lang, duration_hours } = req.body;

  // 🔥 强制修正类型
  duration_hours = Number(duration_hours);

  // 🔥 强制修正司机语言
  if (driver_lang === "中文司机") driver_lang = "ZH";
  if (driver_lang === "日文司机") driver_lang = "JP";

  console.log("🔍 PRICE QUERY PARAMS", {
    car_model_id,
    driver_lang,
    duration_hours,
    typeof_duration: typeof duration_hours,
  });

  if (!car_model_id || !driver_lang || !duration_hours) {
    return res.json({ price: 0, error: "missing params" });
  }

  const { data, error } = await supabase
    .from("car_prices")
    .select("price_rmb")
    .eq("car_model_id", car_model_id)
    .eq("driver_lang", driver_lang)
    .eq("duration_hours", duration_hours)
    .limit(1)
    .single();

  if (error || !data) {
    console.error("❌ NO MATCHED ROW", error);
    return res.json({
      price: 0,
      error: "no matched price row",
      debug: { car_model_id, driver_lang, duration_hours },
    });
  }

  return res.json({ price: Number(data.price_rmb) });
}
