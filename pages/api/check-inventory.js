// pages/api/check-inventory.js
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
    return res.status(400).json({ ok: false });
  }

  const { data, error } = await supabase
    .from("inventory_rules_v")
    .select("date, remaining_qty_calc")
    .eq("car_model_id", car_model_id)
    .gte("date", start_date)
    .lte("date", end_date);

  if (error) {
    console.error("inventory_rules_v error:", error);
    return res.status(500).json({ ok: false });
  }

  // ⭐ 只要有一天 remaining <= 0，就直接拒绝
  const hasNoStock = data.some(d => (d.remaining_qty_calc ?? 0) <= 0);

  return res.json({
    ok: !hasNoStock,
    days: data,
  });
}

