// pages/api/get-car-price.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // ✅ 使用 service role，绕过 RLS
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ price: 0 });
  }

  let { car_model_id, driver_lang, duration_hours } = req.body;

  // ========= ① 参数基础校验 =========
  if (!car_model_id || !driver_lang || !duration_hours) {
    console.error("❌ Missing params:", req.body);
    return res.status(400).json({ price: 0 });
  }

  // ========= ② 强制参数标准化（关键） =========
  car_model_id = String(car_model_id).trim();
  driver_lang = String(driver_lang).trim().toUpperCase(); // ZH / JP
  duration_hours = Number(duration_hours); // 🔥 防止 '10' 字符串问题

  if (!Number.isFinite(duration_hours)) {
    console.error("❌ duration_hours is not a number:", duration_hours);
    return res.status(400).json({ price: 0 });
  }

  // 🔍 调试日志（可保留）
  console.log("✅ PRICE QUERY PARAMS:", {
    car_model_id,
    driver_lang,
    duration_hours,
  });

  // ========= ③ 查询价格（不参与日期） =========
  const { data, error } = await supabase
    .from("car_prices")
    .select("price_rmb")
    .eq("car_model_id", car_model_id)
    .eq("driver_lang", driver_lang)
    .eq("duration_hours", duration_hours)
    .limit(1)
    .single();

  // ========= ④ 错误处理 =========
  if (error) {
    console.error("❌ get-car-price query error:", error);
    return res.json({ price: 0 });
  }

  if (!data || data.price_rmb == null) {
    console.error("❌ get-car-price no data:", {
      car_model_id,
      driver_lang,
      duration_hours,
    });
    return res.json({ price: 0 });
  }

  // ========= ⑤ 成功返回 =========
  return res.json({
    price: Number(data.price_rmb),
  });
}

