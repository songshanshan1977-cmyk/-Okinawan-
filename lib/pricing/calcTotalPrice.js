// lib/pricing/calcTotalPrice.js
//
// Server-side price recompute for create-order.js, so total_price is never
// trusted verbatim from the client. Mirrors the existing client-side pricing
// model used in components/steps/Step2.jsx (fetchDailyPrice + calcDays):
// daily rate (from the real get_car_price RPC, priced off start_date) x
// inclusive day count. This intentionally preserves the current pricing
// *model* (first-day rate x days) — changing that model is out of scope here.
//
// IMPORTANT: prices themselves are NOT hardcoded here. The only source of
// truth for a price is the `get_car_price` RPC (the same one
// pages/api/get-car-price.js already calls) — this module only validates
// the *shape* of the request (duration/car/lang) before asking that RPC.

// The 3 official vehicles (from components/BookingFlow.jsx CAR_MODEL_IDS —
// this list only encodes *which UUIDs are valid*, never their prices).
const VALID_CAR_MODEL_IDS = new Set([
  "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca", // 经济 5 座轿车
  "82cf604f-e688-49fe-aecf-69894a01f6cb", // 豪华 7 座阿尔法
  "453df662-d350-4ab9-b811-61ffcda40d4b", // 舒适 10 座海狮
]);

const VALID_DURATIONS = new Set([8, 10]);
const VALID_DRIVER_LANGS = new Set(["ZH", "JP"]);

function parseYMD(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
}

function calcDays(start_date, end_date) {
  const s = parseYMD(start_date);
  const e = parseYMD(end_date || start_date);
  return Math.floor((e - s) / (1000 * 60 * 60 * 24)) + 1;
}

/**
 * @param {object} params
 * @param {object} params.supabase
 * @param {string} params.car_model_id
 * @param {string} params.driver_lang - "ZH" | "JP" (already normalized by the caller)
 * @param {number} params.duration - 8 | 10
 * @param {string} params.start_date
 * @param {string} params.end_date
 *
 * @returns {Promise<{ ok: true, total_price: number, days: number } | { ok: false, error: string }>}
 */
async function calcTotalPrice({ supabase, car_model_id, driver_lang, duration, start_date, end_date }) {
  if (!car_model_id || !driver_lang || duration === undefined || duration === null || !start_date) {
    return { ok: false, error: "invalid_pricing_request" };
  }

  if (!VALID_CAR_MODEL_IDS.has(car_model_id)) {
    return { ok: false, error: "invalid_car_model" };
  }

  if (!VALID_DURATIONS.has(Number(duration))) {
    return { ok: false, error: "invalid_duration" };
  }

  if (!VALID_DRIVER_LANGS.has(String(driver_lang).toUpperCase())) {
    return { ok: false, error: "invalid_driver_lang" };
  }

  const { data, error } = await supabase.rpc("get_car_price", {
    p_car_model_id: car_model_id,
    p_driver_lang: driver_lang,
    p_duration_hours: Number(duration),
    p_use_date: start_date,
  });

  if (error) {
    return { ok: false, error: "price_lookup_failed" };
  }

  const dailyPrice = Number(data ?? 0);
  if (!(dailyPrice > 0)) {
    return { ok: false, error: "price_unavailable" };
  }

  const days = calcDays(start_date, end_date);
  return { ok: true, total_price: dailyPrice * days, days };
}

module.exports = { calcTotalPrice, calcDays, VALID_CAR_MODEL_IDS, VALID_DURATIONS, VALID_DRIVER_LANGS };
