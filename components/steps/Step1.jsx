// Step1：日期 + 酒店
// ✅ 当日不能下单：start_date 必须 > 今天
// ✅ 回传 order_id，确保流程全程不丢失

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

    // ⭐ 当日不能预约
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const start = new Date(startDate);

    if (start <= today) {
      setError("当日不能下单，请选择明天或更晚的日期。");
      return;
    }

    // ⭐ 回传 order_id（非常关键）
    onNext({
      order_id: initialData.order_id, // ← 保证订单号传回去不丢失
      start_date: startDate,
      end_date: endDate || startDate,
      departure_hotel: departureHotel,
      end_hotel: endHotel || departureHotel,
    });
  };

  return (
    <div>
      <h2 style={{ fontSize: "24px", marginBottom: "16px" }}>
        Step1：选择日期 & 酒店
      </h2>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          maxWidth: "420px",
        }}
      >
        <label>
          用车日期（开始）：
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={{ width: "100%", padding: "8px", marginTop: "4px" }}
          />
        </label>

        <label>
          用车日期（结束，可选）：
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={{ width: "100%", padding: "8px", marginTop: "4px" }}
          />
        </label>

        <label>
          出发酒店：
          <input
            type="text"
            value={departureHotel}
            onChange={(e) => setDepartureHotel(e.target.value)}
            placeholder="例如：那霸市 ○○酒店"
            style={{ width: "100%", padding: "8px", marginTop: "4px" }}
          />
        </label>

        <label>
          结束酒店（可选）：
          <input
            type="text"
            value={endHotel}
            onChange={(e) => setEndHotel(e.target.value)}
            placeholder="不填默认和出发酒店相同"
            style={{ width: "100%", padding: "8px", marginTop: "4px" }}
          />
        </label>

        {error && <div style={{ color: "red" }}>{error}</div>}

        <button
          onClick={handleNext}
          style={{
            marginTop: "16px",
            padding: "10px 20px",
            background: "#2563eb",
            color: "#fff",
            borderRadius: "6px",
            border: "none",
            cursor: "pointer",
          }}
        >
          下一步：选择车型
        </button>
      </div>
    </div>
  );
}
