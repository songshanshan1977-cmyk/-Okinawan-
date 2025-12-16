// pages/api/get-car-price.js

import { createClient } from "@supabase/supabase-js";

// 使用 service role（价格是内部逻辑，前端不可直连）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      car_model_id,
      driver_lang,
      duration_hours,
      date, // 可选：未来用于节假日价
    } = req.body;

    // 🔒 基础校验
    if (!car_model_id || !driver_lang || !duration_hours) {
      return res.status(400).json({
        error: "Missing required fields",
      });
    }

    /**
     * 查询逻辑说明：
     * 1️⃣ 优先找「匹配日期区间」的价格（start_date / end_date）
     * 2️⃣ 如果没有，再找「长期有效」（start_date IS NULL）
     */

    let query = supabase
      .from("car_prices")
      .select("price_rmb")
      .eq("car_model_id", car_model_id)
      .eq("driver_lang", driver_lang)
      .eq("duration_hours", Number(duration_hours))
      .order("start_date", { ascending: false }) // 有日期的优先
      .limit(1);

    // 如果前端传了 date，则启用区间价格匹配
    if (date) {
      query = query.or(
        `and(start_date.lte.${date},end_date.gte.${date}),and(start_date.is.null,end_date.is.null)`
      );
    } else {
      // 默认只取长期价格
      query = query.is("start_date", null);
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      console.error("❌ get-car-price 查询失败:", error);
      return res.status(500).json({ error: "Database error" });
    }

    if (!data) {
      return res.status(404).json({
        error: "Price not found",
      });
    }

    return res.json({
      ok: true,
      price_rmb: data.price_rmb,
    });
  } catch (err) {
    console.error("❌ get-car-price API 异常:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
