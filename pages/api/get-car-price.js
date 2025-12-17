// pages/api/get-car-price.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { car_model_id, driver_lang, duration_hours } = req.body;

  if (!car_model_id || !driver_lang || !duration_hours) {
    return res.status(400).json({
      error: "missing params",
      received: req.body,
    });
  }

  const { data, error, count } = await supabase
    .from("car_prices")
    .select("*", { count: "exact" })
    .eq("car_model_id", car_model_id)
    .eq("driver_lang", driver_lang)
    .eq("duration_hours", duration_hours);

  if (error) {
    return res.status(500).json({
      error: "supabase error",
      detail: error,
    });
  }

  return res.json({
    price: data?.[0]?.price_rmb ?? 0,
    count,
    rows: data,
    debug: {
      car_model_id,
      driver_lang,
      duration_hours,
    },
  });
}
