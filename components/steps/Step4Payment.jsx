import { useState } from "react";

const carNameMap = {
  car1: "经济 5 座轿车",
  car2: "豪华 7 座阿尔法",
  car3: "舒适 10 座海狮",
};

export default function Step4Payment({
  initialData,
  onBack,
  onPaymentSuccess,
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handlePay = async () => {
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/create-payment-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: initialData.order_id, // ⭐ 和后端保持一致
        }),
      });

      if (!res.ok) {
        throw new Error("服务端返回错误");
      }

      const data = await res.json();
      console.log("Stripe Checkout 返回：", data);

      if (!data?.url) {
        throw new Error("未收到支付链接");
      }

      // ⭐ 跳转到 Stripe Checkout 支付页面
      window.location.href = data.url;
      // 支付成功之后，会从 Stripe success_url 回到你的网站
      // 届时你可以在对应页面里触发 onPaymentSuccess（如果需要）
    } catch (err) {
      console.error(err);
      setError("连接支付系统失败，请稍后再试。");
      setLoading(false);
    }
  };

  const {
    order_id,
    car_model,
    driver_lang,
    duration,
    start_date,
    end_date,
    departure_hotel,
    end_hotel,
    name,
    phone,
    email,
    total_price,
  } = initialData;

  return (
    <div>
      <h2 style={{ fontSize: "24px", marginBottom: "8px" }}>Step4：确认并支付押金</h2>
      <p style={{ color: "#6b7280", marginBottom: "16px" }}>
        订单编号：{order_id}
      </p>

      <div
        style={{
          background: "#fff",
          borderRadius: "12px",
          padding: "16px",
          boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
          marginBottom: "16px",
        }}
      >
        <h3 style={{ fontSize: "18px", marginBottom: "8px" }}>订单摘要</h3>
        <p>车型：{carNameMap[car_model]}</p>
        <p>司机语言：{driver_lang === "zh" ? "中文司机" : "日文司机"}</p>
        <p>时长：{duration} 小时</p>
        <p>
          日期：{start_date} → {end_date}
        </p>
        <p>出发酒店：{departure_hotel}</p>
        <p>结束酒店：{end_hotel}</p>
        <p>姓名：{name}</p>
        <p>电话：{phone}</p>
        <p>邮箱：{email}</p>

        <hr style={{ margin: "12px 0" }} />

        <p>包车总费用：¥{total_price}</p>
        <p style={{ fontWeight: 600, color: "#2563eb", marginTop: "4px" }}>
          本次将在 Stripe 支付押金：¥500
        </p>
      </div>

      {error && <div style={{ color: "red", marginBottom: "8px" }}>{error}</div>}

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
          返回上一步
        </button>
        <button
          onClick={handlePay}
          disabled={loading}
          style={{
            padding: "8px 16px",
            borderRadius: "6px",
            border: "none",
            background: "#16a34a",
            color: "#fff",
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? "正在跳转支付..." : "前往 Stripe 支付押金"}
        </button>
      </div>
    </div>
  );
}
