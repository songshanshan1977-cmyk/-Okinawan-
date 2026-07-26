// lib/inventory/checkAvailability.js
//
// Shared server-side inventory availability check, used by both
// pages/api/check-inventory.js (Step2, pre-Step3 gate) and
// pages/api/create-payment-intent.js (server-side re-check before
// creating the Stripe Checkout Session).
//
// Pure-ish function: takes an already-constructed Supabase client so
// callers control connection/env wiring, and so tests can inject a mock
// client with zero real network calls.

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

// "zh"/"jp"/"ZH"/"JP"/... -> "ZH" | "JP" | null (null = invalid/missing)
function normalizeDriverLang(rawLang) {
  if (!rawLang) return null;
  const v = String(rawLang).toUpperCase();
  if (v === "ZH") return "ZH";
  if (v === "JP") return "JP";
  return null;
}

/**
 * @param {object} params
 * @param {object} params.supabase - Supabase client (already constructed by the caller)
 * @param {string} params.start_date - YYYY-MM-DD
 * @param {string} params.end_date - YYYY-MM-DD
 * @param {string} params.car_model_id
 * @param {string} params.driver_lang - "zh"/"jp"/"ZH"/"JP"
 *
 * @returns {Promise<
 *   | { ok: true, available: boolean, unavailable_dates: {date:string, reason:"sold_out"|"inventory_missing"}[], checked: {start_date:string, end_date:string, days_count:number} }
 *   | { ok: false, status: 400|500, error: string }
 * >}
 */
async function checkAvailability({ supabase, start_date, end_date, car_model_id, driver_lang }) {
  const driverLang = normalizeDriverLang(driver_lang);

  if (!car_model_id || !driverLang || !start_date || !end_date) {
    return { ok: false, status: 400, error: "invalid_request" };
  }

  if (parseYMD(end_date) < parseYMD(start_date)) {
    return { ok: false, status: 400, error: "invalid_request" };
  }

  const days = rangeDays(start_date, end_date);

  const { data, error } = await supabase
    .from("inventory_rules_v2")
    .select("date, remaining_qty_calc")
    .eq("car_model_id", car_model_id)
    .eq("driver_lang", driverLang)
    .in("date", days);

  if (error) {
    return { ok: false, status: 500, error: "inventory_check_failed" };
  }

  const map = new Map((data || []).map((r) => [r.date, r]));

  const unavailable_dates = [];
  let min_remaining = Infinity;
  for (const d of days) {
    const row = map.get(d);
    if (!row) {
      unavailable_dates.push({ date: d, reason: "inventory_missing" });
      min_remaining = 0;
      continue;
    }
    const remaining = Number(row.remaining_qty_calc ?? 0);
    if (remaining < min_remaining) min_remaining = remaining;
    if (remaining <= 0) {
      unavailable_dates.push({ date: d, reason: "sold_out" });
    }
  }

  return {
    ok: true,
    available: unavailable_dates.length === 0,
    unavailable_dates,
    min_remaining: Number.isFinite(min_remaining) ? min_remaining : 0,
    checked: {
      start_date,
      end_date,
      days_count: days.length,
    },
  };
}

module.exports = { checkAvailability, normalizeDriverLang, rangeDays };
