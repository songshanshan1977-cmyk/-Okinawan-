// pages/api/get-car-price.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    // ✅ 同时支持 GET / POST（方便你浏览器直接测试）
    const params = req.method === "GET" ? req.query : req.body;

    const {
      car_model_id,
      driver_lang,
      duration_hours,
      use_date,
    } = params;

    // ----------------------------
    // 1️⃣ 参数校验（缺一个直接报错）
    // ----------------------------
    if (!car_model_id || !driver_lang || !duration_hours || !use_date) {
      return res.status(400).json({
        error: "missing params",
        debug: params,
      });
    }

    // ----------------------------
    // 2️⃣ 查询 car_prices（核心）
    // ----------------------------
    const { data, error } = await supabase
      .from("car_prices")
      .select("*")
      .eq("car_model_id", car_model_id)
      .eq("driver_lang", driver_lang)
      .eq("duration_hours", Number(duration_hours))
      .lte("start_date", use_date)
      .gte("end_date", use_date)
      .order("start_date", { ascending: false })
      .limit(1);

    if (error) {
      return res.status(500).json({
        error: "db error",
        message: error.message,
        debug: params,
      });
    }

    // ----------------------------
    // 3️⃣ 没匹配到价格
    // ----------------------------
    if (!data || data.length === 0) {
      return res.json({
        price: 0,
        count: 0,
        rows: [],
        debug: params,
      });
    }

    // ----------------------------
    // 4️⃣ 成功返回价格
    // ----------------------------
    return res.json({
      price: Number(data[0].price_rmb),
      count: data.length,
      rows: data,
      debug: params,
    });
  } catch (e) {
    return res.status(500).json({
      error: "server crash",
      message: e.message,
    });
  }
}

