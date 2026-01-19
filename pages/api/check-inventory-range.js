// pages/api/check-inventory-range.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// YYYY-MM-DD -> Date (local)
function parseYMD(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fmtYMD(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function rangeDays(start, end) {
  const s = parseYMD(start);
  const e = parseYMD(end);
  const out = [];
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    out.push(fmtYMD(d));
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false });
  }

  const { start_date, end_date, car_model_id, driver_lang: rawLang } = req.body || {};

  if (!start_date || !end_date || !car_model_id) {
    return res.status(400).json({ ok: false, message: "参数不完整" });
  }

  // ✅ 最小兼容：没传就默认 ZH（避免旧请求直接挂）
  const driver_lang =
    String(rawLang || "ZH").toUpperCase() === "JP" ? "JP" : "ZH";

  // ✅ 多日规则：只要有一天 <=0 就算无库存
  const daysList = rangeDays(start_date, end_date);

  const { data, error } = await supabase
    .from("inventory_rules_v2")
    .select("date, remaining_qty_calc")
    .eq("car_model_id", car_model_id)
    .eq("driver_lang", driver_lang)
    .in("date", daysList);

  if (error) {
    console.error("check-inventory-range error:", error);
    return res.status(500).json({ ok: false });
  }

  // ✅ 缺日视为 0（防止“没生成库存却能下单”）
  const map = new Map(
    (data || []).map((r) => [r.date, Number(r.remaining_qty_calc ?? 0)])
  );

  const days = daysList.map((d) => {
    const remaining = map.has(d) ? map.get(d) : 0;
    return { date: d, remaining, available: remaining > 0 };
  });

  const hasUnavailable = days.some((d) => d.available === false);

  return res.json({
    ok: !hasUnavailable,
    driver_lang,
    days,
  });
}


