import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  const { car_model_id, driver_lang, duration_hours } = req.query;

  if (!car_model_id || !driver_lang || !duration_hours) {
    return res.status(400).json({ error: "missing params", debug: req.query });
  }

  const { data, error } = await supabase
    .from("car_prices")
    .select("*") // 🔴 关键：先全取
    .eq("car_model_id", car_model_id)
    .eq("driver_lang", driver_lang)
    .eq("duration_hours", Number(duration_hours));

  return res.json({
    count: data?.length || 0,
    rows: data || [],
    error,
    debug: { car_model_id, driver_lang, duration_hours },
  });
}

