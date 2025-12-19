// Step1：日期 + 酒店（不做库存检查）
// 规则：
// 1️⃣ 当日不能下单（静默校验）
// 2️⃣ 结束日期必须晚于开始日期（静默校验）
// 3️⃣ 页面不显示任何规则提示文字

import { useState } from "react";

export default function Step1({ initialData, onNext }) {
  const [startDate, setStartDate] = useState(initialData.start_date || "");
  const [endDate, setEndDate] = useState(initialData.end_date || "");
  const [departureHotel, setDepartureHotel] = useState(
    initialData.departure_hotel || ""
  );
  const [endHotel, setEndHotel] = useState(initialData.end_hotel || "");
  const [error, setError] = useState("");

  const handleNext = () => {
    setError("");

    if (!startDate) {
      setError("请选择用车开始日期");
      return;
    }

    if (!departureHotel) {
      setError("请输入出发酒店");
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(startDate);

    // ❌ 当日不能下单
    if (start <= today) {
      setError("请选择明天或之后的日期");
      return;
    }

    // ❌ 结束日期必须晚于开始日期（如果有选）
    if (endDate) {
      const end = new Date(endDate);
      if (end <= start) {
        setError("结束日期需晚于开始日期");
        return;
      }
    }

    onNext({
      order_id: initialData.order_id,
      start_date: startDate,
      end_date: endDate || startDate,
      departure_hotel: departureHotel,
      end_hotel: endHotel || departureHotel,
    });
  };

  return (
    <div style={{ maxWidth: "900px", margin: "0 auto" }}>
      <h2 style={{ fontSize: "28px", textAlign: "center", marginBottom: "8px" }}>
        立即预订
      </h2>
      <p style={{ textAlign: "center", color: "#666", marginBottom: "32px" }}>
        请选择您期望的包车开始和结束日期
      </p>

      <div style={{ display: "flex", gap: "40px", marginBottom: "24px" }}>
        <div style={{ flex: 1 }}>
          <label>开始日期</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={{ width: "100%", padding: "10px" }}
          />
        </div>

        <div style={{ flex: 1 }}>
          <label>结束日期</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={{ width: "100%", padding: "10px" }}
          />
        </div>
      </div>

      <div style={{ display: "flex", gap: "40px", marginBottom: "24px" }}>
        <div style={{ flex: 1 }}>
          <label>出发酒店</label>
          <input
            type="text"
            value={departureHotel}
            onChange={(e) => setDepartureHotel(e.target.value)}
            style={{ width: "100%", padding: "10px" }}
          />
        </div>

        <div style={{ flex: 1 }}>
          <label>回程酒店</label>
          <input
            type="text"
            value={endHotel}
            onChange={(e) => setEndHotel(e.target.value)}
            style={{ width: "100%", padding: "10px" }}
          />
        </div>
      </div>

      {error && (
        <div style={{ color: "red", marginBottom: "16px" }}>
          {error}
        </div>
      )}

      <div style={{ textAlign: "right" }}>
        <button
          onClick={handleNext}
          style={{
            background: "#3f6df6",
            color: "#fff",
            border: "none",
            padding: "12px 28px",
            fontSize: "16px",
            borderRadius: "6px",
            cursor: "pointer",
          }}
        >
          下一步
        </button>
      </div>
    </div>
  );
}



