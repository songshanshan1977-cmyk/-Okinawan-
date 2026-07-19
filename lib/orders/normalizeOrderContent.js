// lib/orders/normalizeOrderContent.js
//
// Single source of truth for turning a raw set of business fields (either
// a client request body, or an existing `orders` row) into the normalized
// shape used both to COMPARE two orders for content equality and to WRITE
// a fresh draft row. There is deliberately only one normalization function
// so the "what counts as identical" logic and the "what actually gets
// written to the database" logic can never drift apart into two separate,
// inconsistently-maintained copies.
//
// Excluded on purpose (never part of the compared/written business
// content): created_at, payment_status, status, inventory_locked, any
// email_* field, any back-office dispatch field, and the client-submitted
// total_price (total_price is always server-recomputed here).

const { calcTotalPrice } = require("../pricing/calcTotalPrice");

function normalizeDriverLang(lang) {
  const v = String(lang || "").trim().toLowerCase();
  if (v === "jp" || v === "ja" || v === "jpn") return "JP";
  return "ZH"; // 兜底：任何非 JP 都当中文（与既有 create-order.js 行为一致）
}

function toNumberOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 当前写库规则本来就不对文本字段做 trim（原 insert 逻辑是 `data.name` 原样写入），
// 比较逻辑必须和写库规则保持一致，所以这里同样不额外 trim，只统一 undefined -> null。
function toTextOrNull(v) {
  if (v === undefined || v === null) return null;
  return v;
}

// deposit_amount 是固定业务常量，不再是客户提交或数据库存量的"可比较字段"——
// 规范化后两侧永远是同一个值，等价于把它从比较维度里剔除，同时保证新建/复用
// 的草稿写库时都强制使用这个常量。
const FIXED_DEPOSIT_AMOUNT = 500;

/**
 * @param {object} params
 * @param {object} params.supabase
 * @param {object} params.raw - 原始业务字段（来自客户端请求体，或数据库现有行）
 * @param {number} [params.knownTotalPrice] - 若已知价格（如直接复用数据库现有行
 *   的 total_price），跳过一次 RPC 查价；否则强制重新查价（客户端提交的
 *   total_price 永远不会被读取或信任）。
 *
 * @returns {Promise<{ok:true, content:object} | {ok:false, error:string}>}
 */
async function buildNormalizedContent({ supabase, raw, knownTotalPrice }) {
  const driver_lang = normalizeDriverLang(raw.driver_lang);
  const duration = toNumberOrNull(raw.duration);
  const car_model_id = raw.car_model_id ?? null;
  const start_date = raw.start_date ?? null;
  const end_date = raw.end_date ?? null;

  let total_price;
  if (typeof knownTotalPrice === "number") {
    total_price = knownTotalPrice;
  } else {
    const priceResult = await calcTotalPrice({ supabase, car_model_id, driver_lang, duration, start_date, end_date });
    if (!priceResult.ok) {
      return { ok: false, error: priceResult.error };
    }
    total_price = priceResult.total_price;
  }

  return {
    ok: true,
    content: {
      start_date,
      end_date,
      departure_hotel: toTextOrNull(raw.departure_hotel),
      end_hotel: toTextOrNull(raw.end_hotel),
      car_model_id,
      driver_lang,
      duration,
      pax: toNumberOrNull(raw.pax),
      luggage: toNumberOrNull(raw.luggage),
      name: toTextOrNull(raw.name),
      phone: toTextOrNull(raw.phone),
      email: toTextOrNull(raw.email),
      wechat: toTextOrNull(raw.wechat),
      itinerary: toTextOrNull(raw.itinerary),
      remark: toTextOrNull(raw.remark),
      source: raw.source || "direct",
      total_price,
      deposit_amount: FIXED_DEPOSIT_AMOUNT,
    },
  };
}

function contentsEqual(a, b) {
  const keys = Object.keys(a);
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

module.exports = { buildNormalizedContent, contentsEqual, normalizeDriverLang, FIXED_DEPOSIT_AMOUNT };
