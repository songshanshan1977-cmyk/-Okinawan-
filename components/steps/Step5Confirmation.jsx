export default function Step5Confirmation({ orderData, onNext }) {
  const {
    order_id,
    total_price,
    name,
    email,
  } = orderData;

  const depositAmount = 500;
  const balanceAmount = total_price - depositAmount;

  return (
    <div style={{ maxWidth: "600px", margin: "0 auto" }}>
      <h2 style={{ fontSize: "26px", marginBottom: "12px", color: "#16a34a" }}>
        ✅ 支付成功
      </h2>

      <p style={{ marginBottom: "16px", color: "#374151" }}>
        感谢您的预订，我们已成功收到您的押金。
      </p>

      <div
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          padding: "20px",
          boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
          marginBottom: "16px",
        }}
      >
        <p style={{ fontSize: "14px", color: "#6b7280" }}>
          订单编号
        </p>
        <p style={{ fontSize: "18px", fontWeight: 600, marginBottom: "12px" }}>
          {order_id}
        </p>

        <hr style={{ margin: "12px 0" }} />

        <p>包车总价：¥{total_price}</p>
        <p>已支付押金：¥{depositAmount}</p>

        <p
          style={{
            marginTop: "8px",
            fontWeight: 600,
            color: "#2563eb",
          }}
        >
          用车当日需支付尾款：¥{balanceAmount}
        </p>

        <p style={{ fontSize: "13px", color: "#6b7280", marginTop: "6px" }}>
          ※ 尾款将在用车当天，直接向司机结清
        </p>
      </div>

      <div
        style={{
          background: "#f9fafb",
          borderRadius: "12px",
          padding: "16px",
          marginBottom: "20px",
        }}
      >
        <p style={{ marginBottom: "6px" }}>
          📧 订单确认邮件已发送至：
        </p>
        <p style={{ fontWeight: 600 }}>
          {email || "您填写的邮箱地址"}
        </p>

        <p style={{ fontSize: "13px", color: "#6b7280", marginTop: "6px" }}>
          如未收到，请检查垃圾邮箱或联系我们。
        </p>
      </div>

      <button
        onClick={onNext}
        style={{
          width: "100%",
          padding: "12px",
          fontSize: "16px",
          background: "#2563eb",
          color: "#fff",
          border: "none",
          borderRadius: "8px",
          cursor: "pointer",
        }}
      >
        完成
      </button>
    </div>
  );
}


