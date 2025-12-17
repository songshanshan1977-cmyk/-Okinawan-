// pages/api/get-car-price.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    // ⭐ 同时兼容 GET / POST
    const source = req.method === "POST" ? req.body : req.query;

    const car_model_id = source.car_model_id;
    const driver_lang = source.driver_lang;
    const duration = Number(source.duration_hours);

    if (!car_model_id || !driver_lang || !duration) {
      return res.status(400).json({
        error: "missing params",
        debug: { car_model_id, driver_lang, duration },
      });
    }

    const { data, error } = await supabase
      .from("car_prices")
      .select("*")
      .eq("car_model_id", car_model_id)
      .eq("driver_lang", driver_lang)
      .eq("duration_hours", duration);

    if (error) {
      return res.status(500).json({ error });
    }

    return res.json({
      price: data?.[0]?.price_rmb ?? 0,
      count: data.length,
      rows: data,
      debug: { car_model_id, driver_lang, duration },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
