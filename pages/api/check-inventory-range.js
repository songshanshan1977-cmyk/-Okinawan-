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

  const { start_date, end_date, car_model_id, driver_lang: rawLang } = req.body;

  // ✅ 最小兼容：没传就默认 ZH（避免前端还没改就直接 400）
  const driver_lang =
    String(rawLang || "ZH").toUpperCase() === "JP" ? "JP" : "ZH";

  if (!start_date || !end_date || !car_model_id) {
    return res.status(400).json({ ok: false, message: "参数不完整" });
  }

  const { data, error } = await supabase
    .from("inventory_rules_v")
    .select("date, remaining_qty_calc")
    .eq("car_model_id", car_model_id)
    .eq("driver_lang", driver_lang) // ⭐关键：按语言过滤，口径与 create-payment-intent 对齐
    .gte("date", start_date)
    .lte("date", end_date)
    .order("date");

  if (error) {
    console.error("check-inventory-range error:", error);
    return res.status(500).json({ ok: false });
  }

  const days = (data || []).map((d) => ({
    date: d.date,
    remaining: d.remaining_qty_calc,
    available: d.remaining_qty_calc > 0,
  }));

  const hasUnavailable = days.some((d) => d.available === false);

  return res.json({
    ok: !hasUnavailable,
    driver_lang, // 方便你排查到底按什么语言查的
    days,
  });
}

