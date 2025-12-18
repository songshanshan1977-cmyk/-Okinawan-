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

  const { data, error } = await supabase
    .from("inventory")
    .select("stock")              // ✅ 正确字段名
    .eq("date", date)
    .eq("car_model_id", car_model_id);

  if (error) {
    console.error("inventory error:", error);
    return res.status(500).json({ ok: false });
  }

  const totalStock = data.reduce(
    (sum, row) => sum + (row.stock || 0),  // ✅ 正确字段
    0
  );

  return res.json({
    ok: totalStock > 0,
    total_stock: totalStock,
  });
}


