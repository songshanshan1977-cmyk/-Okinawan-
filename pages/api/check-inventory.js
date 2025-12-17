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

  let { date, car_model_id } = req.body;

  if (!date || !car_model_id) {
    return res.status(400).json({ ok: false });
  }

  // ✅ 关键修复：把日期统一裁成 YYYY-MM-DD
  const pureDate = String(date).slice(0, 10);

  const { data, error } = await supabase
    .from("inventory")
    .select("stock")
    .eq("date", pureDate)
    .eq("car_model_id", car_model_id);

  if (error) {
    console.error("inventory error:", error);
    return res.status(500).json({ ok: false });
  }

  const totalStock = (data || []).reduce(
    (sum, row) => sum + (row.stock || 0),
    0
  );

  return res.json({
    ok: totalStock > 0,
    total_stock: totalStock,
    date: pureDate,
  });
}


