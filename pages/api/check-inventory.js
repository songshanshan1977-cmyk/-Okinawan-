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

  // ✅ 核心：同一天 + 同车型 → 汇总库存
  const { data, error } = await supabase
    .from("inventory")
    .select("stock")
    .eq("date", date)
    .eq("car_model_id", car_model_id);

  if (error) {
    console.error("inventory error:", error);
    return res.status(500).json({ ok: false });
  }

  const totalStock = data.reduce((sum, row) => sum + (row.stock || 0), 0);

  return res.json({
    ok: totalStock > 0,
    total_stock: totalStock,
  });
}

