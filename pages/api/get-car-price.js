import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  throw new Error("Missing Supabase env vars");
}

const supabase = createClient(supabaseUrl, serviceKey);

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const {
      car_model_id,
      driver_lang,
      duration_hours,
      use_date,
    } = req.query;

    if (!car_model_id || !driver_lang || !duration_hours || !use_date) {
      return res.status(400).json({
        error: "missing params",
        debug: { car_model_id, driver_lang, duration_hours, use_date },
      });
    }

    // ⭐ 只调用 SQL 函数
    const { data, error } = await supabase.rpc("get_car_price", {
      p_car_model_id: car_model_id,
      p_driver_lang: driver_lang,
      p_duration_hours: Number(duration_hours),
      p_use_date: use_date,
    });

    if (error) {
      return res.status(500).json({
        error: error.message,
        debug: { car_model_id, driver_lang, duration_hours, use_date },
      });
    }

    // ⭐ 关键修正点：data 是一个 number，不是数组
    if (data === null) {
      return res.status(200).json({
        price: 0,
        debug: { car_model_id, driver_lang, duration_hours, use_date },
      });
    }

    return res.status(200).json({
      price: data, // ← 直接就是 2600
      debug: { car_model_id, driver_lang, duration_hours, use_date },
    });
  } catch (e) {
    return res.status(500).json({
      error: "internal_error",
      message: e.message,
    });
  }
}



