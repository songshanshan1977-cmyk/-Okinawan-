import { createClient } from "@supabase/supabase-js";

/**
 * GET /api/get-car-price
 * params:
 *  - car_model_id (uuid)
 *  - driver_lang (ZH | JP)
 *  - duration_hours (8 | 10)
 *  - use_date (YYYY-MM-DD)
 */
export default async function handler(req, res) {
  try {
    const {
      car_model_id,
      driver_lang,
      duration_hours,
      use_date,
    } = req.query;

    // ---------- 参数校验 ----------
    if (!car_model_id || !driver_lang || !duration_hours || !use_date) {
      return res.status(400).json({
        error: "missing params",
        debug: { car_model_id, driver_lang, duration_hours, use_date },
      });
    }

    // ---------- Supabase Client ----------
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({
        error: "missing env",
        debug: {
          hasUrl: !!supabaseUrl,
          hasServiceKey: !!serviceKey,
        },
      });
    }

    const supabase = createClient(supabaseUrl, serviceKey);

    // ---------- 1️⃣ 查「带日期规则」 ----------
    const { data: datedRows, error: datedError } = await supabase
      .from("car_prices")
      .select("*")
      .eq("car_model_id", car_model_id)
      .eq("driver_lang", driver_lang)
      .eq("duration_hours", Number(duration_hours))
      .lte("start_date", use_date)
      .gte("end_date", use_date)
      .order("start_date", { ascending: false })
      .limit(1);

    if (datedError) {
      return res.status(500).json({
        error: "dated query failed",
        detail: datedError.message,
      });
    }

    if (datedRows && datedRows.length > 0) {
      return res.status(200).json({
        price: datedRows[0].price,
        picked: "dated",
        row: datedRows[0],
      });
    }

    // ---------- 2️⃣ 查「基础价（无日期）」 ----------
    const { data: baseRows, error: baseError } = await supabase
      .from("car_prices")
      .select("*")
      .eq("car_model_id", car_model_id)
      .eq("driver_lang", driver_lang)
      .eq("duration_hours", Number(duration_hours))
      .is("start_date", null)
      .is("end_date", null)
      .limit(1);

    if (baseError) {
      return res.status(500).json({
        error: "base query failed",
        detail: baseError.message,
      });
    }

    if (baseRows && baseRows.length > 0) {
      return res.status(200).json({
        price: baseRows[0].price,
        picked: "base",
        row: baseRows[0],
      });
    }

    // ---------- 3️⃣ 都没命中 ----------
    return res.status(200).json({
      price: 0,
      picked: null,
      debug: {
        car_model_id,
        driver_lang,
        duration_hours,
        use_date,
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: "unexpected error",
      detail: err.message,
    });
  }
}


