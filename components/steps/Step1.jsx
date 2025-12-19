// Step1：日期 + 酒店（不做库存检查）
// ✅ 当日不能下单
// ✅ 结束日期必须大于开始日期
// ✅ 只负责收集信息，库存留到 Step2

import { useState } from "react";

export default function Step1({ initialData, onNext }) {
  const [startDate, setStartDate] = useState(initialData.start_date || "");
  const [endDate, setEndDate] = useState(initialData.end_date || "");
  const [departureHotel, setDepartureHotel] = useState(
    initialData.departure_hotel || ""
  );
  const [endHotel, setEndHotel] = useState(
    initialData.end_hotel || ""
  );
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

    // ⛔ 当日不能下单
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(startDate);

    if (start <= today) {
      setError("当日不能下单，请选择明天或更晚的日期");
      return;
    }

    // ⛔ 结束日期必须大于开始日期
    if (endDate) {
      const end = new Date(endDate);
      if (end <= start) {
        setError("结束日期必须大于开始日期");
        return;
      }
    }

    // ✅ 进入 Step2（不查库存）
    onNext({
      order_id: initialData.order_id,
      start_date: startDate,
      end_date: endDate || startDate,
      departure_hotel: departureHotel,
      end_hotel: endHotel || departureHotel,
    });
  };

  return (
    <div style={{ maxWidth: "720px", margin: "0 auto" }}>
      <h2 style={{ fontSize: "28px", marginBottom: "8px", textAlign: "center" }}>
        立即预订
      </h2>
      <p style={{ textAlign: "center", color: "#666", marginBottom: "32px" }}>
        请选择您期望的包车开始和结束日期
      </p>

      <div style={{ display: "flex", gap: "40px", marginBottom: "24px" }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontWeight: "bold" }}>开始日期</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={{ width: "100%", marginTop: "6px" }}
          />
        </div>

        <div style={{ flex: 1 }}>
          <label style={{ fontWeight: "bold" }}>结束日期</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={{ width: "100%", marginTop: "6px" }}
          />
          <div style={{ fontSize: "12px", color: "#888", marginTop: "4px" }}>
            结束日期必须大于开始日期
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: "40px", marginBottom: "24px" }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontWeight: "bold" }}>出发酒店</label>
          <input
            type="text"
            value={departureHotel}
            onChange={(e) => setDepartureHotel(e.target.value)}
            style={{ width: "100%", marginTop: "6px" }}
          />
        </div>

        <div style={{ flex: 1 }}>
          <label style={{ fontWeight: "bold" }}>回程酒店</label>
          <input
            type="text"
            value={endHotel}
            onChange={(e) => setEndHotel(e.target.value)}
            style={{ width: "100%", marginTop: "6px" }}
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
            padding: "12px 28px",
            fontSize: "16px",
            backgroundColor: "#2563eb",
            color: "#fff",
            border: "none",
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

