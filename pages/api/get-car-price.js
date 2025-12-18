import { createClient } from "@supabase/supabase-js";

/**
 * GET /api/get-car-price
 * 参数：
 * - car_model_id (uuid)
 * - driver_lang (ZH | JP)
 * - duration_hours (8 | 10)
 * - use_date (YYYY-MM-DD)
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 基本保护（防止未来踩坑）
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

    // 参数校验（你现在看到 debug，说明这里是 OK 的）
    if (!car_model_id || !driver_lang || !duration_hours || !use_date) {
      return res.status(400).json({
        error: "missing params",
        debug: { car_model_id, driver_lang, duration_hours, use_date },
      });
    }

    // ⭐ 核心：只调用 SQL 函数，不写任何复杂逻辑
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

    // 没命中价格（理论上不会发生，除非数据真没）
    if (!data || data.length === 0) {
      return res.status(200).json({
        price: 0,
        picked: null,
        debug: { car_model_id, driver_lang, duration_hours, use_date },
      });
    }

    // 命中一条（SQL 已保证优先级）
    const picked = data[0];

    return res.status(200).json({
      price: picked.price_rmb,
      picked,
      debug: { car_model_id, driver_lang, duration_hours, use_date },
    });
  } catch (e) {
    return res.status(500).json({
      error: "internal_error",
      message: e.message,
    });
  }
}


