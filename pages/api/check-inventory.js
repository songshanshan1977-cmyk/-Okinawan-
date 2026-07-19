// pages/api/check-inventory.js
import { createClient } from "@supabase/supabase-js";
const { checkAvailability } = require("../../lib/inventory/checkAvailability");

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false });
  }

  const body = req.body || {};
  const car_model_id = body.car_model_id;
  const driver_lang = body.driver_lang;

  // ✅ 兼容两套参数：
  // 单日：date
  // 多日：start_date / end_date
  const start_date = body.start_date || body.date;
  const end_date = body.end_date || body.date;

  if (!car_model_id || !driver_lang || !start_date || !end_date) {
    console.warn("check-inventory missing params", {
      car_model_id,
      driver_lang,
      start_date,
      end_date,
    });
    return res.status(400).json({
      ok: false,
      error: "invalid_request",
    });
  }

  const result = await checkAvailability({
    supabase,
    start_date,
    end_date,
    car_model_id,
    driver_lang,
  });

  if (!result.ok) {
    if (result.status === 500) {
      console.error("check-inventory: inventory check failed", result.error);
    }
    return res.status(result.status).json({ ok: false, error: result.error });
  }

  // ✅ 新字段（多日）+ 旧字段（保留，避免单日调用方回归）
  const first_bad_date = result.unavailable_dates[0]?.date ?? null;

  return res.json({
    // 新契约
    available: result.available,
    unavailable_dates: result.unavailable_dates,
    checked: result.checked,

    // 旧契约（兼容保留，remaining_qty 语义不变：区间内最小可用量）
    ok: result.available,
    remaining_qty: result.min_remaining,
    first_bad_date,
  });
}
