// pages/api/create-order.js

import { createClient } from "@supabase/supabase-js";
const { calcTotalPrice } = require("../../lib/pricing/calcTotalPrice");
const { buildNormalizedContent, contentsEqual, normalizeDriverLang } = require("../../lib/orders/normalizeOrderContent");
const { insertNewDraftWithRetry } = require("../../lib/orders/generateOrderId");
const { issuePaymentAuthorization } = require("../../lib/payment/paymentAuthorization");

// A3: 无论走哪条分支确定了权威订单（复用旧draft / 内容变化生成新draft / 全新插入），
// 都必须在返回"可付款结果"之前签发一次性付款授权——网页 Step4 之后调用
// create-payment-intent 必须携带这个 Token 才能创建 Stripe Session（见
// lib/payment/paymentAuthorization.js / lib/payment/createCheckoutSession.js）。
// 签发失败就不允许返回可付款结果：调用方拿不到 Token 也就无法完成支付，这是
// 唯一安全的失败模式，不做"降级为不可用Token"之类的静默兜底。
async function issueAuthorizationOrFail({ supabase, order, res, extra }) {
  const authResult = await issuePaymentAuthorization({ supabase, order });
  if (!authResult.ok) {
    res.status(500).json({ error: "payment_authorization_failed" });
    return null;
  }
  return res.status(200).json({
    ...extra,
    payment_authorization_token: authResult.token,
    payment_authorization_expires_at: authResult.expires_at,
  });
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// A3 revision：draft/pending/其他（含 paid）三态分开判断，而不是把
// draft/pending 当成同一种"可继续处理"状态笼统对待——pending 意味着已经存在
// 一次真实的付款尝试（可能已经创建过 Stripe Checkout Session），draft 则从未
// 有过付款尝试。二者允许的后续动作不同（见 handler 里的分支）。
function classifyExistingOrderStatus(order) {
  const status = String(order?.payment_status || "").toLowerCase();
  if (status === "draft") return "draft";
  if (status === "pending") return "pending";
  return "immutable"; // paid，或任何非 draft/pending 的其他状态
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
      const statusClass = classifyExistingOrderStatus(existing);

      // ── 已付款/不可回退状态：任何请求一律拒绝，绝不做静默替代 ──
      // （不允许通过"内容不同就创建新单"的机制绕过已付款订单的不可变性）
      if (statusClass === "immutable") {
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

      // 现有订单的规范化内容（直接复用已存的 total_price，不用重新查价）
      const existingContentResult = await buildNormalizedContent({
        supabase,
        raw: existing,
        knownTotalPrice: existing.total_price,
      });

      // existingContentResult.ok 为 false 时（现有草稿的车型/时长/语言已不再合法，
      // 理论上极少发生）短路为"内容不同"，走下方分支——这是安全默认值，不需要
      // 单独分支处理。
      const sameContent =
        existingContentResult.ok && contentsEqual(newContentResult.content, existingContentResult.content);

      // ── pending（已有一次真实付款尝试）+ 内容不同：拒绝，绝不允许创建一个
      //    内容不同的新草稿来绕过已存在的付款尝试。 ──
      if (statusClass === "pending" && !sameContent) {
        return res.status(409).json({ error: "payment_pending_immutable" });
      }

      if (sameContent) {
        // ── 完全相同：不 insert、不 update业务字段，原样返回旧订单 ──
        // pending + 相同内容：重新签发 Token 但保留同一 payment_attempt_id
        // （见 issue_payment_authorization_v1），createCheckoutSession 用同一
        // Stripe idempotencyKey 恢复同一个 Session，不创建第二个。
        return await issueAuthorizationOrFail({
          supabase,
          order: existing,
          res,
          extra: { success: true, order: existing, reused: true, created_new_order: false },
        });
      }

      // ── draft + 内容不同：绝不修改旧 draft。服务端生成新 order_id，插入
      //    独立新草稿 ── （pending 分支已在上面提前 return，不会走到这里）
      const insertResult = await insertNewDraftWithRetry({
        supabase,
        content: newContentResult.content,
      });

      if (!insertResult.ok) {
        return res.status(500).json({ error: insertResult.error });
      }

      return await issueAuthorizationOrFail({
        supabase,
        order: insertResult.order,
        res,
        extra: {
          success: true,
          order: insertResult.order,
          reused: false,
          created_new_order: true,
          previous_order_id: existing.order_id,
        },
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

    return await issueAuthorizationOrFail({
      supabase,
      order,
      res,
      extra: { success: true, order, reused: false, created_new_order: false },
    });
  } catch (err) {
    console.error("❌ create-order exception:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
