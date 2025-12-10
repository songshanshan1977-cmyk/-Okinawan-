export default function Step5Confirmation({ initialData, onNext, onBack }) {
  return (
    <div>
      <h2 style={{ fontSize: "24px", marginBottom: "8px" }}>Step5：支付确认</h2>
      <p style={{ marginBottom: "12px" }}>
        如果你是从 Stripe 支付成功页面跳回来的，这里可以展示“支付成功、订单已确认”。<br />
        后端 Webhook 会自动：
      </p>
      <ul style={{ marginBottom: "12px" }}>
        <li>✅ 更新订单状态为 paid</li>
        <li>✅ 扣减对应日期的库存</li>
        <li>✅ 发送确认邮件给客人</li>
      </ul>

      <p style={{ marginBottom: "12px" }}>
        当前订单编号：<strong>{initialData.order_id}</strong>
      </p>

      <div style={{ display: "flex", gap: "8px" }}>
        <button
          onClick={onBack}
          style={{
            padding: "8px 16px",
            borderRadius: "6px",
            border: "1px solid #ccc",
            background: "#f3f4f6",
          }}
        >
          返回
        </button>
        <button
          onClick={onNext}
          style={{
            padding: "8px 16px",
            borderRadius: "6px",
            border: "none",
            background: "#2563eb",
            color: "#fff",
          }}
        >
          完成
        </button>
      </div>
    </div>
  );
}
