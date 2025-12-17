// pages/api/get-car-price.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    const {
      car_model_id,
      driver_lang,
      duration_hours,
      duration, // 👈 兼容旧前端
    } = req.query;

    const finalDuration = Number(duration_hours ?? duration);

    // 参数检查
    if (!car_model_id || !driver_lang || !finalDuration) {
      return res.status(400).json({
        error: "missing params",
        debug: { car_model_id, driver_lang, duration_hours, duration },
      });
    }

    const { data, error } = await supabase
      .from("car_prices")
      .select("price_rmb, driver_lang, duration_hours")
      .eq("car_model_id", car_model_id)
      .eq("driver_lang", driver_lang)
      .eq("duration_hours", finalDuration);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      price: data?.[0]?.price_rmb ?? 0,
      count: data.length,
      rows: data,
      debug: {
        car_model_id,
        driver_lang,
        duration_hours: finalDuration,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

