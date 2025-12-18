import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  const {
    car_model_id,
    driver_lang,
    duration_hours,
    use_date,
  } = req.query;

  // 基础校验
  if (!car_model_id || !driver_lang || !duration_hours) {
    return res.status(400).json({
      error: "missing params",
      debug: { car_model_id, driver_lang, duration_hours, use_date },
    });
  }

  const hours = Number(duration_hours);
  const date = use_date || null;

  /**
   * Step A：优先查「有日期命中的价格规则」
   */
  let pricedRow = null;

  if (date) {
    const { data: datedRows, error } = await supabase
      .from("car_prices")
      .select("*")
      .eq("car_model_id", car_model_id)
      .eq("driver_lang", driver_lang)
      .eq("duration_hours", hours)
      .lte("start_date", date)
      .gte("end_date", date)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (datedRows && datedRows.length > 0) {
      pricedRow = datedRows[0];
    }
  }

  /**
   * Step B：如果没有日期规则，fallback 到「基础价格（start_date IS NULL）」
   */
  if (!pricedRow) {
    const { data: baseRows, error } = await supabase
      .from("car_prices")
      .select("*")
      .eq("car_model_id", car_model_id)
      .eq("driver_lang", driver_lang)
      .eq("duration_hours", hours)
      .is("start_date", null)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (baseRows && baseRows.length > 0) {
      pricedRow = baseRows[0];
    }
  }

  /**
   * Step C：统一返回
   */
  return res.status(200).json({
    price: pricedRow ? pricedRow.price_rmb : 0,
    picked: pricedRow || null,
    debug: {
      car_model_id,
      driver_lang,
      duration_hours: hours,
      use_date: date,
    },
  });
}


