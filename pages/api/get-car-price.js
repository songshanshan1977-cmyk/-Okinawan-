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
    .eq("duration_hours", duration_hours)
    .limit(1);

  if (error) {
    console.error("❌ get-car-price error:", error);
    return res.json({ price: 0 });
  }

  if (!data || data.length === 0) {
    console.warn("⚠️ get-car-price: no row found", {
      car_model_id,
      driver_lang,
      duration_hours,
    });
    return res.json({ price: 0 });
  }

  return res.json({
    price: Number(data[0].price_rmb) || 0,
  });
}

