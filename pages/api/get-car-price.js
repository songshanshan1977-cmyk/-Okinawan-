import { createClient } from "@supabase/supabase-js";

/**
 * 环境变量（JS 语法）
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  throw new Error("Missing Supabase environment variables");
}

const supabase = createClient(supabaseUrl, serviceKey);

/**
 * GET /api/get-car-price
 *
 * 参数：
 *  - car_model_id   (uuid) 必填
 *  - driver_lang    (ZH / JP) 必填
 *  - duration_hours (8 / 10) 必填
 *  - use_date       (YYYY-MM-DD) 可选
 *
 * 规则（已定）：
 *  1️⃣ 若有 use_date：优先匹配【带日期】价格
 *  2️⃣ 若无命中：回退【无日期】基础价
 *  3️⃣ 永远只返回 1 条
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

    let data = [];
    let error = null;

    /**
     * ===============================
     * A️⃣ 有 use_date → 先查「带日期」
     * ===============================
     */
    if (use_date) {
      const resWithDate = await supabase
        .from("car_prices")
        .select("*")
        .eq("car_model_id", car_model_id)
        .eq("driver_lang", driver_lang)
        .eq("duration_hours", Number(duration_hours))
        .lte("start_date", use_date)
        .gte("end_date", use_date)
        .order("start_date", { ascending: false })
        .limit(1);

      if (resWithDate.error) {
        return res.status(500).json({
          error: resWithDate.error.message,
          stage: "with_date",
        });
      }

      if (resWithDate.data.length > 0) {
        data = resWithDate.data;
      }
    }

    /**
     * ===============================
     * B️⃣ 如果没查到 → 查「无日期基础价」
     * ===============================
     */
    if (data.length === 0) {
      const resBase = await supabase
        .from("car_prices")
        .select("*")
        .eq("car_model_id", car_model_id)
        .eq("driver_lang", driver_lang)
        .eq("duration_hours", Number(duration_hours))
        .is("start_date", null)
        .is("end_date", null)
        .limit(1);

      if (resBase.error) {
        return res.status(500).json({
          error: resBase.error.message,
          stage: "base_price",
        });
      }

      data = resBase.data;
    }

    const picked = data.length > 0 ? data[0] : null;

    return res.status(200).json({
      price: picked ? Number(picked.price_rmb) : 0,
      count: data.length,
      rows: data,
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


