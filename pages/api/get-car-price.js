import { createClient } from "@supabase/supabase-js";

/**
 * 环境变量（JS 写法，不能用 !）
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  throw new Error("Missing Supabase environment variables");
}

const supabase = createClient(supabaseUrl, serviceKey);

/**
 * GET /api/get-car-price
 * 参数：
 *  - car_model_id (uuid)   必填
 *  - driver_lang   (ZH/JP) 必填
 *  - duration_hours (8/10) 必填
 *  - use_date (YYYY-MM-DD) 可选
 *
 * 价格规则（已定稿）：
 *  1️⃣ 优先匹配【带日期】且命中的价格规则
 *  2️⃣ 如果没有，再回退到【无日期】基础价
 *  3️⃣ 永远只返回 1 条最终价格
 */
export default async function handler(req, res) {
  try {
    const {
      car_model_id,
      driver_lang,
      duration_hours,
      use_date,
    } = req.method === "GET" ? req.query : req.body;

    // -------- 参数校验 --------
    if (!car_model_id || !driver_lang || !duration_hours) {
      return res.status(400).json({
        error: "missing params",
        debug: { car_model_id, driver_lang, duration_hours, use_date },
      });
    }

    // -------- 查询 car_prices --------
    let query = supabase
      .from("car_prices")
      .select("*")
      .eq("car_model_id", car_model_id)
      .eq("driver_lang", driver_lang)
      .eq("duration_hours", Number(duration_hours));

    /**
     * 如果传了 use_date：
     *  - 同时允许【带日期命中】和【无日期基础价】
     *  - ORDER BY start_date DESC：带日期优先
     */
    if (use_date) {
      query = query.or(
        `
        and(start_date.lte.${use_date},end_date.gte.${use_date}),
        and(start_date.is.null,end_date.is.null)
        `
      ).order("start_date", { ascending: false, nullsLast: true });
    } else {
      /**
       * 没传日期：只走基础价
       */
      query = query
        .is("start_date", null)
        .is("end_date", null);
    }

    // 只取 1 条最终规则
    const { data, error } = await query.limit(1);

    if (error) {
      return res.status(500).json({
        error: error.message,
        debug: { car_model_id, driver_lang, duration_hours, use_date },
      });
    }

    const picked = data && data.length > 0 ? data[0] : null;

    return res.status(200).json({
      price: picked ? Number(picked.price_rmb) : 0,
      count: data ? data.length : 0,
      rows: data || [],
      debug: {
        car_model_id,
        driver_lang,
        duration_hours,
        use_date: use_date ?? null,
        picked,
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: "internal error",
      message: err.message,
    });
  }
}

