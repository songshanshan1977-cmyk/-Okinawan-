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

    // 当日不能预约
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(startDate);

    if (start <= today) {
      setError("当日不能下单，请选择明天或更晚的日期。");
      return;
    }

    // ✅ 结束日期必须大于开始日期（如果填写了）
    if (endDate) {
      const end = new Date(endDate);
      if (end <= start) {
        setError("结束日期必须大于开始日期");
        return;
      }
    }

    // ✅ 直接进入 Step2，不做任何库存请求
    onNext({
      order_id: initialData.order_id,
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
          />
        </label>

        <label>
          用车日期（结束，可选）：
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
          <div style={{ fontSize: "12px", color: "#666", marginTop: "4px" }}>
            结束日期必须大于开始日期
          </div>
        </label>

        <label>
          出发酒店：
          <input
            type="text"
            value={departureHotel}
            onChange={(e) => setDepartureHotel(e.target.value)}
          />
        </label>

        <label>
          结束酒店（可选）：
          <input
            type="text"
            value={endHotel}
            onChange={(e) => setEndHotel(e.target.value)}
          />
        </label>

        {error && <div style={{ color: "red" }}>{error}</div>}

        <button onClick={handleNext}>下一步：选择车型</button>
      </div>
    </div>
  );
}

