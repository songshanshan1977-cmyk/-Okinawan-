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
   * ✅ 关键修正点
   * 不是看“有没有记录”
   * 而是看：是否存在 可用库存 > 0
   *
   * 👉 如果你当前表里只有 stock，
   * 那就必须要求 stock > 0
   */
  const { data, error } = await supabase
    .from("inventory")
    .select("stock")
    .eq("date", date)
    .eq("car_model_id", car_model_id)
    .gt("stock", 0); // ⭐⭐⭐ 核心修复

  if (error) {
    console.error("inventory error:", error);
    return res.status(500).json({ ok: false });
  }

  return res.json({
    ok: data.length > 0, // 只要有一条 stock > 0 即可
    total_stock: data.reduce((sum, row) => sum + (row.stock || 0), 0),
  });
}

