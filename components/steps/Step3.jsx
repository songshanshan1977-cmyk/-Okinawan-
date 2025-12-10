import { useState } from "react";

const carNameMap = {
  car1: "经济 5 座轿车",
  car2: "豪华 7 座阿尔法",
  car3: "舒适 10 座海狮",
};

export default function Step3({ initialData, onNext, onBack }) {
  const [name, setName] = useState(initialData.name || "");
  const [phone, setPhone] = useState(initialData.phone || "");
  const [email, setEmail] = useState(initialData.email || "");
  const [remark, setRemark] = useState(initialData.remark || "");
  const [error, setError] = useState("");

  const handleNext = () => {
    setError("");

    if (!name || !phone) {
      setError("姓名和电话为必填项");
      return;
    }

    onNext({
      name,
      phone,
      email,
      remark,
    });
  };

  const {
    order_id,
    start_date,
    end_date,
    departure_hotel,
    end_hotel,
    car_model,
    driver_lang,
    duration,
    total_price,
  } = initialData;

  return (
    <div>
      <h2 style={{ fontSize: "24px", marginBottom: "8px" }}>Step3：订单预览</h2>
      <p style={{ color: "#6b7280", marginBottom: "16px" }}>
        请确认以下信息后，填写联系方式。
      </p>
      <p style={{ color: "#4b5563", marginBottom: "16px", fontSize: "14px" }}>
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
        <h3 style={{ fontSize: "18px", marginBottom: "8px" }}>📅 用车信息</h3>
        <p>开始日期：{start_date}</p>
        <p>结束日期：{end_date}</p>
        <p>出发酒店：{departure_hotel}</p>
        <p>结束酒店：{end_hotel}</p>

        <hr style={{ margin: "12px 0" }} />

        <h3 style={{ fontSize: "18px", marginBottom: "8px" }}>🚗 车型 & 服务</h3>
        <p>车型：{carNameMap[car_model] || "未选择"}</p>
        <p>司机语言：{driver_lang === "zh" ? "中文司机" : "日文司机"}</p>
        <p>包车时长：{duration} 小时</p>
        <p>包车费用：¥{total_price}</p>
        <p style={{ color: "#2563eb", fontWeight: 600, marginTop: "4px" }}>
          需支付押金：¥500（固定）
        </p>
      </div>

      <div
        style={{
          background: "#fff",
          borderRadius: "12px",
          padding: "16px",
          boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
          marginBottom: "16px",
        }}
      >
        <h3 style={{ fontSize: "18px", marginBottom: "8px" }}>👤 客户信息</h3>

        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <label>
            姓名（必填）：
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ width: "100%", padding: "8px", marginTop: "4px" }}
            />
          </label>

          <label>
            电话（必填）：
            <input
              type="text"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              style={{ width: "100%", padding: "8px", marginTop: "4px" }}
            />
          </label>

          <label>
            邮箱（选填）：
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ width: "100%", padding: "8px", marginTop: "4px" }}
            />
          </label>

          <label>
            备注（选填）：
            <textarea
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              rows={3}
              style={{ width: "100%", padding: "8px", marginTop: "4px" }}
            />
          </label>
        </div>
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
          返回修改
        </button>
        <button
          onClick={handleNext}
          style={{
            padding: "8px 16px",
            borderRadius: "6px",
            border: "none",
            background: "#2563eb",
            color: "#fff",
          }}
        >
          确认并前往支付
        </button>
      </div>
    </div>
  );
}
