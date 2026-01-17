// pages/api/check-inventory.js
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
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  const body = req.body || {};
  const car_model_id = body.car_model_id;

  // ✅ 新增：司机语言（库存维度的一部分）
  // 兼容：ZH/JP 或 zh/jp
  const rawLang = body.driver_lang;
  const driver_lang = rawLang
    ? String(rawLang).toUpperCase() === "ZH"
      ? "ZH"
      : String(rawLang).toUpperCase() === "JP"
      ? "JP"
      : null
    : null;

  // ✅ 兼容两套参数：
  // 旧：date
  // 新：start_date/end_date
  const start = body.start_date || body.date;
  const end = body.end_date || body.date;

  if (!car_model_id || !start || !end || !driver_lang) {
    return res.status(400).json({
      ok: false,
      error: "missing params",
      got: {
        car_model_id: !!car_model_id,
        start: !!start,
        end: !!end,
        driver_lang: !!driver_lang,
      },
    });
  }

  // ✅ 多日：任意一天剩余<=0 => 无库存
  const days = rangeDays(start, end);

  const { data, error } = await supabase
    .from("inventory_rules_v2")
    .select("date, remaining_qty_calc")
    .eq("car_model_id", car_model_id)
    .eq("driver_lang", driver_lang)
    .in("date", days);

  if (error) {
    console.error("inventory_rules_v error:", error);
    return res.status(500).json({ ok: false });
  }

  // ✅ 缺日当 0（避免“中间没记录还能下”的漏洞）
  const map = new Map(
    (data || []).map((r) => [r.date, Number(r.remaining_qty_calc ?? 0)])
  );

  let min = Infinity;
  let firstBad = null;

  for (const d of days) {
    const r = map.has(d) ? map.get(d) : 0;
    if (r < min) min = r;
    if (r <= 0 && !firstBad) firstBad = d;
  }

  return res.json({
    ok: min > 0,
    remaining_qty: Number.isFinite(min) ? min : 0,
    first_bad_date: firstBad,
    checked: { start_date: start, end_date: end, days_count: days.length },
  });
}

