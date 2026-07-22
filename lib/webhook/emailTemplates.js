// lib/webhook/emailTemplates.js
//
// Email content for the two possible post-payment outcomes:
//   - "locked": inventory was successfully secured -> existing "booking
//     confirmed" copy (byte-for-byte carried over from the pre-v1 webhook,
//     domain/date fixes included).
//   - "failed" / "duplicate_payment_conflict": Stripe payment succeeded but
//     the order could not be auto-confirmed -> new "deposit received,
//     pending manual confirmation" copy. Deliberately does NOT promise the
//     booking is confirmed, and does NOT ask the customer to pay again.

const { maskId } = require("./maskId");

const THANK_YOU_URL = (orderId) =>
  `https://booking.xn--okinawa-n14kh45a.com/booking?step=5&order_id=${encodeURIComponent(orderId)}`;

// UUID -> 中文车型名（沿用既有映射，未改动）
const CAR_MODEL_ZH_MAP = {
  "453df662-d350-4ab9-b811-61ffcda40d4b": "海狮车型",
  "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca": "经济型轿车",
  "82cf604f-e688-49fe-aecf-69894a01f6cb": "豪华 阿尔法",
};

function getCarModelZh(carModelId) {
  if (!carModelId) return "-";
  return CAR_MODEL_ZH_MAP[carModelId] || carModelId;
}

function getDriverLangZh(driverLang) {
  const v = String(driverLang || "ZH").toUpperCase();
  return v === "JP" ? "日文司机" : "中文司机";
}

function money(v) {
  if (v === null || v === undefined || v === "") return "-";
  const n = Number(v);
  return Number.isFinite(n) ? `${n} RMB` : `${v} RMB`;
}

function dateRangeText(order) {
  return order.end_date && order.end_date !== order.start_date
    ? `${order.start_date} → ${order.end_date}`
    : order.start_date || "-";
}

// Stripe Session ID 只在运营邮件里以不可逆哈希摘要形式出现，与日志使用
// 同一个 maskId 实现，避免两处脱敏规则不一致。R2-B05/N-01：不再是可截断
// 还原的前缀+后缀（那仍然是原始 ID 的一部分），换成单向摘要后，运营已
// 不能直接凭邮件内容去 Stripe Dashboard 按 ID 搜索——需要的话应改为按
// order_id 查 payments/send_logs 表定位对应的真实 Session。
const maskSessionId = maskId;

const FAILURE_REASON_ZH = {
  currency_mismatch: "支付币种与订单不符",
  amount_mismatch: "支付金额与订单不符",
  invalid_date_range: "订单日期范围无效",
  failed_missing_inventory: "所选日期区间存在缺失的库存记录",
  failed_no_stock: "所选日期区间库存不足",
  order_id_source_mismatch: "订单号来源不一致（metadata 与 client_reference_id 冲突）",
  order_already_paid_by_different_session: "该订单已被另一笔 Stripe 支付标记为已付款",
  stripe_session_id_bound_to_different_order: "该 Stripe Session 已绑定到另一个订单",
};

function failureReasonZh(reason) {
  return FAILURE_REASON_ZH[reason] || reason || "未知原因";
}

// ================= 成功路径：预约已确认（沿用既有文案与域名） =================
function buildCustomerSuccessEmail(order) {
  const deposit = order.deposit_amount ?? 500;
  const total = order.total_price ?? null;
  const balance = order.balance_due ?? (total !== null ? Number(total) - Number(deposit) : null);
  const carZh = getCarModelZh(order.car_model_id);
  const langZh = getDriverLangZh(order.driver_lang);
  const btnUrl = THANK_YOU_URL(order.order_id);

  return {
    subject: `HonestOki 预约确认｜订单 ${order.order_id}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.7;color:#111">
        <h2 style="margin:0 0 12px 0;">预约已确认（押金已支付）</h2>

        <p><b>订单号：</b>${order.order_id || "-"}</p>
        <p><b>用车日期：</b>${dateRangeText(order)}</p>
        <p><b>车型：</b>${carZh}</p>
        <p><b>司机语言：</b>${langZh}</p>
        <p><b>包车时长：</b>${order.duration ? `${order.duration} 小时` : "-"}</p>

        <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

        <p><b>全款：</b>${money(total)}</p>
        <p><b>押金：</b>${money(deposit)}（已支付）</p>
        <p><b>尾款：</b>${balance !== null ? `${money(balance)}（用车当日支付司机）` : "用车当日支付司机"}</p>

        <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

        <p><b>客人名字：</b>${order.name || "-"}</p>
        <p><b>电话：</b>${order.phone || "-"}</p>
        <p><b>微信：</b>${order.wechat || "-"}</p>
        <p><b>邮箱：</b>${order.email || "-"}</p>

        <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

        <p>若手机端支付宝未自动跳回，请点击确认单按钮查看。</p>

        <div style="margin-top:14px;">
          <a href="${btnUrl}"
             style="display:inline-block;padding:12px 18px;background:#2f6fec;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">
            查看新订单确认单（感谢页）
          </a>
        </div>
      </div>
    `,
  };
}

function buildOpsSuccessEmail(order) {
  const deposit = order.deposit_amount ?? 500;
  const total = order.total_price ?? null;
  const balance = order.balance_due ?? (total !== null ? Number(total) - Number(deposit) : null);
  const carZh = getCarModelZh(order.car_model_id);
  const langZh = getDriverLangZh(order.driver_lang);

  return {
    subject: `【新订单】${order.order_id}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.7;color:#111">
        <h2 style="margin:0 0 12px 0;">新订单通知</h2>

        <p><b>订单号：</b>${order.order_id || "-"}</p>
        <p><b>用车日期：</b>${dateRangeText(order)}</p>
        <p><b>车型：</b>${carZh}</p>
        <p><b>司机语言：</b>${langZh}</p>
        <p><b>包车时长：</b>${order.duration ? `${order.duration} 小时` : "-"}</p>

        <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

        <p><b>全款：</b>${money(total)}</p>
        <p><b>押金：</b>${money(deposit)}（已支付）</p>
        <p><b>尾款：</b>${balance !== null ? money(balance) : "-"}</p>

        <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

        <p><b>客人名字：</b>${order.name || "-"}</p>
        <p><b>电话：</b>${order.phone || "-"}</p>
        <p><b>微信：</b>${order.wechat || "-"}</p>
        <p><b>邮箱：</b>${order.email || "-"}</p>
      </div>
    `,
  };
}

// ================= 失败/冲突路径：押金已收到，等待人工确认 =================
function buildCustomerPendingEmail(order) {
  return {
    subject: `HonestOki 预约状态｜订单 ${order.order_id} 押金已收到，等待确认`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.7;color:#111">
        <h2 style="margin:0 0 12px 0;">押金已收到，您的预约正在人工确认</h2>

        <p><b>订单号：</b>${order.order_id || "-"}</p>
        <p><b>用车日期：</b>${dateRangeText(order)}</p>

        <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

        <p>我们已经收到您的押金支付，但系统未能自动完成预约确认。</p>
        <p>工作人员会在核实后尽快与您联系，暂不需要您重复支付或采取任何操作。</p>
        <p>如有疑问，请通过订单号 ${order.order_id || "-"} 与我们联系。</p>
      </div>
    `,
  };
}

function buildOpsUrgentEmail(order, reason, stripeSessionId) {
  return {
    subject: `【需要立即处理】已付款但预约未自动确认 - ${order.order_id}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.7;color:#111">
        <h2 style="margin:0 0 12px 0;color:#c00;">【需要立即处理】已付款但预约未自动确认</h2>

        <p><b>订单号：</b>${order.order_id || "-"}</p>
        <p><b>失败原因：</b>${failureReasonZh(reason)}（${reason || "-"}）</p>
        <p><b>用车日期：</b>${dateRangeText(order)}</p>
        <p><b>车型：</b>${getCarModelZh(order.car_model_id)}</p>
        <p><b>司机语言：</b>${getDriverLangZh(order.driver_lang)}</p>
        <p><b>Stripe Session ID（安全摘要，不可还原）：</b>${maskSessionId(stripeSessionId)}</p>

        <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />

        <p>客户已完成 Stripe 付款，但系统未能自动完成库存锁定/订单确认。</p>
        <p>请人工核实库存与订单信息后，与客户联系确认车辆安排。</p>
      </div>
    `,
  };
}

// 同一个 Stripe Session 先绑定了订单 A，随后又被请求用于订单 B —— 这是
// 一个应当永不发生的异常，本身就足够可疑，不向任何一方发送"预约成功"
// 类邮件，只通知运营人工核对，不在邮件里暴露完整 Session ID。
function buildOpsSessionOrderConflictEmail({ attemptedOrderId, existingOrderId, stripeSessionId }) {
  return {
    subject: `【需要人工核对】同一笔 Stripe 支付关联了两个订单号`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.7;color:#111">
        <h2 style="margin:0 0 12px 0;color:#c00;">【需要人工核对】同一 Stripe Session 与两个订单号发生冲突</h2>

        <p>同一笔 Stripe 支付（Session）先前已经关联到订单 <b>${existingOrderId || "-"}</b>，
        但本次收到的付款回调又携带了不同的订单号 <b>${attemptedOrderId || "-"}</b>。</p>

        <p>系统未对任何一个订单做出"支付成功"的自动确认，也未锁定库存，需要人工核实这笔支付的真实归属后再手动处理。</p>

        <p><b>Stripe Session ID（安全摘要，不可还原）：</b>${maskSessionId(stripeSessionId)}</p>
      </div>
    `,
  };
}

module.exports = {
  buildCustomerSuccessEmail,
  buildOpsSuccessEmail,
  buildCustomerPendingEmail,
  buildOpsUrgentEmail,
  buildOpsSessionOrderConflictEmail,
  maskSessionId,
  failureReasonZh,
};
