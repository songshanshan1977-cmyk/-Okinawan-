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
    } = req.query;

    // 🔴 关键修复点：把字符串转成数字
    const duration = Number(duration_hours);

    if (!car_model_id || !driver_lang || !duration) {
      return res.status(400).json({
        error: "missing params",
        debug: { car_model_id, driver_lang, duration_hours },
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
      debug: {
        car_model_id,
        driver_lang,
        duration_hours: duration,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

