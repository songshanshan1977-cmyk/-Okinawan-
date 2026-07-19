// pages/api/create-order.js

import { createClient } from "@supabase/supabase-js";
const { calcTotalPrice } = require("../../lib/pricing/calcTotalPrice");

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

// ✅ 未付款 draft 允许客户端更新的字段白名单（7.1）
const DRAFT_UPDATE_WHITELIST = [
  "start_date",
  "end_date",
  "departure_hotel",
  "end_hotel",
  "car_model_id",
  "driver_lang",
  "duration",
  "pax",
  "luggage",
  "name",
  "phone",
  "email",
  "wechat",
  "itinerary",
  "remark",
  "source",
];

function isPaidOrImmutable(order) {
  // payment_status 不是 draft/pending 视为不可再修改（含 paid 及任何非草稿态）
  const status = String(order?.payment_status || "").toLowerCase();
  return status !== "draft" && status !== "pending";
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

    // ✅ [保留] 幂等：先查同一个 order_id 是否已存在
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
      // ✅ 已付款/不可回退状态：拒绝任何修改，原样返回 409
      if (isPaidOrImmutable(existing)) {
        return res.status(409).json({ error: "paid_order_immutable" });
      }

      // ✅【新增】未付款 draft 受控更新：只接受白名单字段，忽略其余
      const patch = {};
      for (const field of DRAFT_UPDATE_WHITELIST) {
        if (data[field] !== undefined) {
          patch[field] = field === "driver_lang" ? normalizeDriverLang(data[field]) : data[field];
        }
      }

      // 没有任何可更新字段时，直接原样返回（视为纯复用）
      if (Object.keys(patch).length === 0) {
        return res.status(200).json({ success: true, order: existing, reused: true, updated: false });
      }

      // ✅ 服务端重新计算 total_price（不信任客户端提交值）
      const nextCarModelId = patch.car_model_id ?? existing.car_model_id;
      const nextDriverLang = patch.driver_lang ?? existing.driver_lang;
      const nextDuration = patch.duration ?? existing.duration;
      const nextStartDate = patch.start_date ?? existing.start_date;
      const nextEndDate = patch.end_date ?? existing.end_date;

      const priceResult = await calcTotalPrice({
        supabase,
        car_model_id: nextCarModelId,
        driver_lang: nextDriverLang,
        duration: nextDuration,
        start_date: nextStartDate,
        end_date: nextEndDate,
      });

      if (!priceResult.ok) {
        return res.status(400).json({ error: priceResult.error });
      }

      patch.total_price = priceResult.total_price;
      // deposit_amount 使用固定正式规则，不接受客户端修改（保持现值/默认值）
      if (existing.deposit_amount == null) {
        patch.deposit_amount = 500;
      }

      const { data: updated, error: updateErr } = await supabase
        .from("orders")
        .update(patch)
        .eq("order_id", existing.order_id)
        .eq("payment_status", existing.payment_status) // 防止并发中途变成已付款
        .select()
        .single();

      if (updateErr) {
        console.error("❌ Supabase update existing order error:", updateErr);
        return res.status(500).json({ error: updateErr.message });
      }

      return res.status(200).json({ success: true, order: updated, reused: true, updated: true });
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

    // ✅【新增】服务端重新计算 total_price，不信任客户端提交值
    const priceResult = await calcTotalPrice({
      supabase,
      car_model_id: data.car_model_id,
      driver_lang: driverLangNormalized,
      duration: data.duration,
      start_date: data.start_date,
      end_date: data.end_date,
    });

    if (!priceResult.ok) {
      return res.status(400).json({ error: priceResult.error });
    }

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

          total_price: priceResult.total_price, // ✅ 服务端计算，不再信任客户端
          deposit_amount: data.deposit_amount ?? 500,

          name: data.name,
          phone: data.phone,
          email: data.email,
          remark: data.remark,

          // ✅ 只新增：行程 + 微信（可选字段，不影响原逻辑）
          itinerary: data.itinerary ?? null,
          wechat: data.wechat ?? null,

          payment_status: "draft",
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
      reused: false,
      updated: false,
    });
  } catch (err) {
    console.error("❌ create-order exception:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
