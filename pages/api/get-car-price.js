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
      use_date,
    } = req.query;

    // ---------- 1️⃣ 参数校验 ----------
    if (!car_model_id || !driver_lang || !duration_hours || !use_date) {
      return res.status(400).json({
        error: "missing params",
        debug: { car_model_id, driver_lang, duration_hours, use_date },
      });
    }

    // ---------- 2️⃣ 查价格（按日期区间） ----------
    const { data, error } = await supabase
      .from("car_prices")
      .select("*")
      .eq("car_model_id", car_model_id)
      .eq("driver_lang", driver_lang)
      .eq("duration_hours", Number(duration_hours))
      .lte("start_date", use_date)
      .gte("end_date", use_date)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({
        error: error.message,
        debug: { car_model_id, driver_lang, duration_hours, use_date },
      });
    }

    // ---------- 3️⃣ 返回 ----------
    return res.json({
      price: data?.[0]?.price_rmb ?? 0,
      count: data.length,
      rows: data,
      debug: {
        car_model_id,
        driver_lang,
        duration_hours,
        use_date,
      },
    });
  } catch (e) {
    return res.status(500).json({
      error: "server_error",
      message: e.message,
    });
  }
}
