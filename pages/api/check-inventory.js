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

  const { date, car_model_id } = req.body;

  if (!date || !car_model_id) {
    return res.status(400).json({ ok: false });
  }

  /**
   * ⭐ 改动点说明
   * - 不再读取 inventory.stock
   * - 统一走规则视图 inventory_rules_v
   * - 以 remaining_qty_calc 作为唯一判断依据
   */

  const { data, error } = await supabase
    .from("inventory_rules_v")
    .select("remaining_qty_calc")
    .eq("date", date)
    .eq("car_model_id", car_model_id)
    .maybeSingle();

  if (error) {
    console.error("inventory_rules_v error:", error);
    return res.status(500).json({ ok: false });
  }

  const remaining = data?.remaining_qty_calc ?? 0;

  return res.json({
    ok: remaining > 0,
    remaining_qty: remaining,
  });
}

