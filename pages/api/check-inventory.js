// pages/api/check-inventory.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function toYMD(d) {
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateRange(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  const out = [];
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    out.push(toYMD(d));
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  const { date, start_date, end_date, car_model_id } = req.body || {};

  if (!car_model_id) return res.status(400).json({ ok: false, error: "missing car_model_id" });

  // ✅ 兼容：旧前端只传 date
  const start = start_date || date;
  const end = end_date || date;

  if (!start || !end) {
    return res.status(400).json({ ok: false, error: "missing date/start_date/end_date" });
  }

  // ✅ 多日必须逐日判断：任何一天 remaining<=0 就失败
  const days = dateRange(start, end);

  const { data, error } = await supabase
    .from("inventory_rules_v")
    .select("date, remaining_qty_calc")
    .eq("car_model_id", car_model_id)
    .in("date", days);

  if (error) {
    console.error("inventory_rules_v error:", error);
    return res.status(500).json({ ok: false });
  }

  // 如果视图里缺了某一天，也要当作 0（否则会出现“中间断档还能下”的漏洞）
  const map = new Map((data || []).map((r) => [r.date, Number(r.remaining_qty_calc ?? 0)]));

  let minRemaining = Infinity;
  let firstBadDate = null;

  for (const d of days) {
    const r = map.has(d) ? map.get(d) : 0; // ✅ 缺日=0
    if (r < minRemaining) minRemaining = r;
    if (r <= 0 && !firstBadDate) firstBadDate = d;
  }

  return res.json({
    ok: minRemaining > 0,
    remaining_qty: Number.isFinite(minRemaining) ? minRemaining : 0,
    first_bad_date: firstBadDate, // ✅ 哪一天卡住，前端可直接提示
    checked: { start_date: start, end_date: end, days_count: days.length },
  });
}

