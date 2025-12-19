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

    // 当日不能预约
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(startDate);

    if (start <= today) {
      setError("当日不能预约，请选择明天或之后的日期");
      return;
    }

    // ✅ 如果填写了结束日期，必须大于开始日期
    if (endDate) {
      const end = new Date(endDate);
      if (end <= start) {
        setError("结束日期必须晚于开始日期");
        return;
      }
    }

    // ✅ 通过校验，进入 Step2
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
      <h2 style={{ fontSize: "24px", marginBottom: "12px" }}>
        Step1：选择日期 & 酒店
      </h2>

      {/* 轻提示文案（不是报错） */}
      <div style={{ fontSize: "14px", color: "#666", marginBottom: "16px" }}>
        请选择您的包车开始日期与结束日期（结束日期需晚于开始日期）
      </div>

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
          回程酒店（可选）：
          <input
            type="text"
            value={endHotel}
            onChange={(e) => setEndHotel(e.target.value)}
          />
        </label>

        {error && (
          <div style={{ color: "#d93025", marginTop: "4px" }}>
            {error}
          </div>
        )}

        <button onClick={handleNext}>
          下一步：选择车型
        </button>
      </div>
    </div>
  );
}


