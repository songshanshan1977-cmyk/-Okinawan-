import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { car_model_id, driver_lang, duration } = req.body;

  if (!car_model_id || !driver_lang || !duration) {
    return res.status(400).json({ error: "Missing params" });
  }

  const { data, error } = await supabase
    .from("car_prices")
    .select("price_rmb")
    .eq("car_model_id", car_model_id)
    .eq("driver_lang", driver_lang)
    .eq("duration_hour", duration)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return res.status(404).json({ error: "Price not found" });
  }

  return res.json({ price: data.price_rmb });
}
