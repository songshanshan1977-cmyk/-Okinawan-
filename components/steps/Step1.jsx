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
      setError("请选择开始日期");
      return;
    }

    if (!endDate) {
      setError("请选择结束日期");
      return;
    }

    if (!departureHotel.trim()) {
      setError("请输入出发酒店");
      return;
    }

    if (!endHotel.trim()) {
      setError("请输入回程酒店");
      return;
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    // ❌ 结束日期不能早于开始日期
    if (end < start) {
      setError("结束日期不能早于开始日期");
      return;
    }

    onNext({
      order_id: initialData.order_id,
      start_date: startDate,
      end_date: endDate,
      departure_hotel: departureHotel,
      end_hotel: endHotel,
    });
  };

  return (
    <div style={{ maxWidth: "980px", margin: "0 auto" }}>
      <h2 style={{ fontSize: "28px", textAlign: "center", marginBottom: "6px" }}>
        立即预订
      </h2>
      <p style={{ textAlign: "center", color: "#666", marginBottom: "28px" }}>
        请选择您期望的包车开始和结束日期
      </p>

      {/* 日期 */}
      <div style={{ display: "flex", gap: "48px", marginBottom: "28px" }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontWeight: 600 }}>开始日期</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: "8px",
              border: "1px solid #dcdcdc",
            }}
          />
        </div>

        <div style={{ flex: 1 }}>
          <label style={{ fontWeight: 600 }}>结束日期</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: "8px",
              border: "1px solid #dcdcdc",
            }}
          />
        </div>
      </div>

      {/* 酒店 */}
      <div style={{ display: "flex", gap: "48px", marginBottom: "24px" }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontWeight: 600 }}>出发酒店</label>
          <input
            type="text"
            value={departureHotel}
            onChange={(e) => setDepartureHotel(e.target.value)}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: "8px",
              border: "1px solid #dcdcdc",
            }}
          />
        </div>

        <div style={{ flex: 1 }}>
          <label style={{ fontWeight: 600 }}>回程酒店</label>
          <input
            type="text"
            value={endHotel}
            onChange={(e) => setEndHotel(e.target.value)}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: "8px",
              border: "1px solid #dcdcdc",
            }}
          />
        </div>
      </div>

      {error && (
        <div style={{ color: "#d93025", marginBottom: "16px" }}>
          {error}
        </div>
      )}

      <div style={{ textAlign: "right" }}>
        <button
          onClick={handleNext}
          style={{
            background: "#4c6ef5",
            color: "#fff",
            border: "none",
            padding: "12px 30px",
            fontSize: "16px",
            borderRadius: "10px",
            cursor: "pointer",
          }}
        >
          下一步
        </button>
      </div>
    </div>
  );
}





