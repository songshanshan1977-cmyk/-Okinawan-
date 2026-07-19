// pages/api/create-order.js

import { createClient } from "@supabase/supabase-js";
const { calcTotalPrice } = require("../../lib/pricing/calcTotalPrice");
const { buildNormalizedContent, contentsEqual, normalizeDriverLang } = require("../../lib/orders/normalizeOrderContent");
const { insertNewDraftWithRetry } = require("../../lib/orders/generateOrderId");

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function isPaidOrImmutable(order) {
  // payment_status 不是 draft/pending 视为不可再修改（含 paid 及任何非草稿态）
  const status = String(order?.payment_status || "").toLowerCase();
  return status !== "draft" && status !== "pending";
}

const REQUIRED_FIELDS = [
  "car_model_id",
  "duration",
  "pax",
  "luggage",
  "start_date",
  "end_date",
  "departure_hotel",
  "end_hotel",
];

function findMissingField(data) {
  for (const field of REQUIRED_FIELDS) {
    if (data[field] === null || data[field] === undefined) return field;
  }
  return null;
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

    // ✅ 先查同一个 order_id 是否已存在（.select("*") 取全字段，避免比较时漏字段）
    const { data: existing, error: existingErr } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", String(data.order_id).trim())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingErr) {
      console.error("❌ Supabase select existing order error:", existingErr);
      return res.status(500).json({ error: "order_lookup_failed" });
    }

    if (existing) {
      // ── 已付款/不可回退状态：任何请求一律拒绝，绝不做静默替代 ──
      // （不允许通过"内容不同就创建新单"的机制绕过已付款订单的不可变性）
      if (isPaidOrImmutable(existing)) {
        return res.status(409).json({ error: "paid_order_immutable" });
      }

      const missingField = findMissingField(data);
      if (missingField) {
        return res.status(400).json({ error: `Missing required field: ${missingField}` });
      }

      // 新请求的规范化内容（total_price 永远服务端重算，不信任客户端）
      const newContentResult = await buildNormalizedContent({ supabase, raw: data });
      if (!newContentResult.ok) {
        return res.status(400).json({ error: newContentResult.error });
      }

      // 现有 draft 的规范化内容（直接复用已存的 total_price，不用重新查价）
      const existingContentResult = await buildNormalizedContent({
        supabase,
        raw: existing,
        knownTotalPrice: existing.total_price,
      });

      // existingContentResult.ok 为 false 时（现有草稿的车型/时长/语言已不再合法，
      // 理论上极少发生）短路为"内容不同"，走下方新建分支——这是安全默认值，
      // 不需要单独分支处理。
      const sameContent =
        existingContentResult.ok && contentsEqual(newContentResult.content, existingContentResult.content);

      if (sameContent) {
        // ── 完全相同：不 insert、不 update，原样返回旧 draft ──
        return res.status(200).json({
          success: true,
          order: existing,
          reused: true,
          created_new_order: false,
        });
      }

      // ── 内容不同：绝不修改旧 draft。服务端生成新 order_id，插入独立新草稿 ──
      const insertResult = await insertNewDraftWithRetry({
        supabase,
        content: newContentResult.content,
      });

      if (!insertResult.ok) {
        return res.status(500).json({ error: insertResult.error });
      }

      return res.status(200).json({
        success: true,
        order: insertResult.order,
        reused: false,
        created_new_order: true,
        previous_order_id: existing.order_id,
      });
    }

    // ── 全新 order_id（数据库里从未出现过）：沿用客户端提交的 order_id 首次入库 ──
    // 这不是本次安全修复涉及的场景：不存在"篡改他人订单"的风险，因为此时数据库
    // 里还没有任何行可以被篡改。
    const missingField = findMissingField(data);
    if (missingField) {
      return res.status(400).json({
        error: `Missing required field: ${missingField}`,
      });
    }

    const driverLangNormalized = normalizeDriverLang(data.driver_lang);

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
          driver_lang: driverLangNormalized,
          duration: data.duration,
          pax: data.pax,
          luggage: data.luggage,

          start_date: data.start_date,
          end_date: data.end_date,
          departure_hotel: data.departure_hotel,
          end_hotel: data.end_hotel,

          total_price: priceResult.total_price, // ✅ 服务端计算，不再信任客户端
          deposit_amount: 500, // ✅ 固定业务常量（顺手修正 9），不再读取 data.deposit_amount

          name: data.name,
          phone: data.phone,
          email: data.email,
          remark: data.remark,

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
      return res.status(500).json({ error: "order_creation_failed" });
    }

    return res.status(200).json({
      success: true,
      order,
      reused: false,
      created_new_order: false,
    });
  } catch (err) {
    console.error("❌ create-order exception:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
