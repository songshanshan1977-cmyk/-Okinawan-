// lib/orders/generateOrderId.js
//
// Server-side order_id generation for the "existing draft superseded by
// new content" path — the client can no longer specify the replacement
// ID (see BLOCKING-1 fix). Format and date semantics are kept byte-for-byte
// compatible with the original client-side generator in
// components/BookingFlow.jsx (`ORD-YYYYMMDD-NNNNN`, UTC date via
// `toISOString()`), so this fix does not change order-number date
// semantics site-wide. The only change is swapping Math.random() for a
// cryptographically-safe generator.

const crypto = require("crypto");

function generateOrderId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // UTC，与既有前端生成逻辑一致
  const random = crypto.randomInt(10000, 100000); // [10000, 100000) 五位数，非 Math.random()
  return `ORD-${date}-${random}`;
}

const UNIQUE_VIOLATION_CODE = "23505"; // Postgres unique_violation

/**
 * 生成新 order_id 并插入一条新草稿订单；命中唯一约束冲突时更换候选 ID 重试，
 * 最多 maxAttempts 次。任何非唯一冲突的数据库错误立即失败，不做无意义重试，
 * 也不把数据库错误详情返回调用方。
 *
 * @param {object} params
 * @param {object} params.supabase
 * @param {object} params.content - buildNormalizedContent() 产出的规范化业务内容
 * @param {number} [params.maxAttempts=3]
 * @returns {Promise<{ok:true, order:object} | {ok:false, error:string}>}
 */
async function insertNewDraftWithRetry({ supabase, content, maxAttempts = 3 }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidateId = generateOrderId();

    const { data, error } = await supabase
      .from("orders")
      .insert([
        {
          ...content,
          // ⚠️ order_id 必须放在展开之后：即使 content 意外携带 order_id 字段，
          // 服务端生成的 candidateId 也永远优先，客户端/上游调用方无法覆盖它。
          order_id: candidateId,
          payment_status: "draft",
          inventory_status: "pending",
          email_status: "pending",
        },
      ])
      .select()
      .single();

    if (!error) {
      return { ok: true, order: data };
    }

    if (error.code !== UNIQUE_VIOLATION_CODE) {
      // 不是 order_id 唯一冲突（其它数据库错误）：不重试，直接安全失败
      return { ok: false, error: "order_creation_failed" };
    }
    // 唯一冲突：换一个新候选 ID 进入下一次循环重试
  }

  return { ok: false, error: "order_id_generation_failed" };
}

module.exports = { generateOrderId, insertNewDraftWithRetry, UNIQUE_VIOLATION_CODE };
