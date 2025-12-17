import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    const { car_model_id, driver_lang, duration_hours } = req.query;

    // 参数检查
    if (!car_model_id || !driver_lang || !duration_hours) {
      return res.status(400).json({
        error: "missing params",
        debug: req.query,
      });
    }

    // ⭐ 强制转 int（关键中的关键）
    const hours = parseInt(duration_hours, 10);

    // ⭐ 查询（一次性写清楚）
    const { data, error } = await supabase
      .from("car_prices")
      .select("price_rmb, driver_lang, duration_hours")
      .eq("car_model_id", car_model_id)
      .eq("driver_lang", driver_lang)
      .eq("duration_hours", hours)
      .limit(1);

    if (error) {
      return res.status(500).json({
        error: error.message,
        debug: { car_model_id, driver_lang, hours },
      });
    }

    return res.status(200).json({
      price: data?.[0]?.price_rmb ?? 0,
      count: data?.length ?? 0,
      rows: data ?? [],
      debug: {
        car_model_id,
        driver_lang,
        duration_hours: hours,
      },
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message,
    });
  }
}

