// pages/api/create-order.js

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ✅【仅新增】把前端 zh/jp 统一成库存用的 ZH/JP（不改其它任何逻辑）
function normalizeDriverLang(lang) {
  const v = String(lang || "").trim().toLowerCase();
  if (v === "jp" || v === "ja" || v === "jpn") return "JP";
  return "ZH"; // 兜底：任何非 JP 都当中文
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const data = req.body;

    if (!data?.order_id) {
      return res.status(400).json({ error: "Missing order_id" });
    }

    // ✅ [仅新增] 幂等：同一个 order_id 已存在 → 直接返回，不再重复 insert
    const { data: existing, error: existingErr } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", String(data.order_id).trim())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingErr) {
      console.error("❌ Supabase select existing order error:", existingErr);
      return res.status(500).json({ error: existingErr.message });
    }

    if (existing) {
      // ✅【仅新增】如果复用旧订单，但 driver_lang 不是 ZH/JP，则“轻量纠正一次”
      // 这不影响任何业务流程，只是让后续 lock_inventory_v2 不踩坑
      const normalized = normalizeDriverLang(existing.driver_lang);
      const existingUpper = String(existing.driver_lang || "").trim().toUpperCase();

      if (existingUpper !== "ZH" && existingUpper !== "JP") {
        await supabase
          .from("orders")
          .update({ driver_lang: normalized })
          .eq("order_id", existing.order_id);
        existing.driver_lang = normalized; // 返回给前端也同步一下
      }

      return res.status(200).json({
        success: true,
        order: existing,
        reused: true, // ✅ 标记：本次是复用旧订单（不影响前端）
      });
    }

    // ✅ 所有 NOT NULL 字段做防御校验
    const requiredFields = [
      "car_model_id",
      "duration",
      "pax",
      "luggage",
      "start_date",
      "end_date",
      "departure_hotel",
      "end_hotel",
      "total_price",
    ];

    for (const field of requiredFields) {
      if (data[field] === null || data[field] === undefined) {
        return res.status(400).json({
          error: `Missing required field: ${field}`,
          debug: data,
        });
      }
    }

    // ✅【仅新增】统一 driver_lang 写入 ZH/JP
    const driverLangNormalized = normalizeDriverLang(data.driver_lang);

    const { data: order, error } = await supabase
      .from("orders")
      .insert([
        {
          order_id: data.order_id,
          car_model_id: data.car_model_id,

          // ✅ 原来是 data.driver_lang：现在只做标准化，不改字段含义
          driver_lang: driverLangNormalized,

          duration: data.duration, // ✅ 关键修复
          pax: data.pax, // ✅
          luggage: data.luggage, // ✅

          start_date: data.start_date,
          end_date: data.end_date,
          departure_hotel: data.departure_hotel,
          end_hotel: data.end_hotel,

          total_price: data.total_price,
          deposit_amount: data.deposit_amount ?? 500,

          name: data.name,
          phone: data.phone,
          email: data.email,
          remark: data.remark,

          // ✅ 只新增：行程 + 微信（可选字段，不影响原逻辑）
          itinerary: data.itinerary ?? null,
          wechat: data.wechat ?? null,

          payment_status: "pending",
          inventory_status: "pending",
          email_status: "pending",
          source: data.source || "direct",
        },
      ])
      .select()
      .single();

    if (error) {
      console.error("❌ Supabase insert error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      success: true,
      order,
    });
  } catch (err) {
    console.error("❌ create-order exception:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

