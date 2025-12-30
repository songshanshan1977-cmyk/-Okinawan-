// pages/api/check-inventory-range.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false });
  }

  const { start_date, end_date, car_model_id } = req.body;

  if (!start_date || !end_date || !car_model_id) {
    return res.status(400).json({ ok: false, message: "参数不完整" });
  }

  const { data, error } = await supabase
    .from("inventory_rules_v")
    .select("date, remaining_qty_calc")
    .eq("car_model_id", car_model_id)
    .gte("date", start_date)
    .lte("date", end_date)
    .order("date");

  if (error) {
    console.error("check-inventory-range error:", error);
    return res.status(500).json({ ok: false });
  }

  const days = data.map((d) => ({
    date: d.date,
    remaining: d.remaining_qty_calc,
    available: d.remaining_qty_calc > 0,
  }));

  const hasUnavailable = days.some((d) => d.available === false);

  return res.json({
    ok: !hasUnavailable,
    days,
  });
}
