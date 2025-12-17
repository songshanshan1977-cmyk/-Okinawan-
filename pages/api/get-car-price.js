import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    // ⭐ 同时兼容 query 和 body
    const source = req.method === "POST" ? req.body : req.query;

    const car_model_id = source?.car_model_id;
    const driver_lang = source?.driver_lang;
    const duration_hours = source?.duration_hours;

    if (!car_model_id || !driver_lang || !duration_hours) {
      return res.status(400).json({
        error: "missing params",
        debug: source,
      });
    }

    const hours = parseInt(duration_hours, 10);

    const { data, error } = await supabase
      .from("car_prices")
      .select("price_rmb")
      .eq("car_model_id", car_model_id)
      .eq("driver_lang", driver_lang)
      .eq("duration_hours", hours)
      .limit(1);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      price: data?.[0]?.price_rmb ?? 0,
      rows: data ?? [],
      debug: { car_model_id, driver_lang, duration_hours: hours },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}


