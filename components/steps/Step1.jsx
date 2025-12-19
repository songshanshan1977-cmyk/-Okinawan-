import { useState } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/dist/style.css";

export default function Step1({ initialData, onNext }) {
  const [range, setRange] = useState({
    from: initialData.start_date
      ? new Date(initialData.start_date)
      : undefined,
    to: initialData.end_date
      ? new Date(initialData.end_date)
      : undefined,
  });

  const [departureHotel, setDepartureHotel] = useState(
    initialData.departure_hotel || ""
  );
  const [endHotel, setEndHotel] = useState(
    initialData.end_hotel || ""
  );
  const [error, setError] = useState("");

  // 今天 & 明天（稳定，不吃时区）
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const handleNext = () => {
    setError("");

    if (!range?.from) {
      setError("请选择用车日期");
      return;
    }

    if (!departureHotel.trim()) {
      setError("请输入出发酒店");
      return;
    }

    const start = range.from;
    const end = range.to || range.from;

    if (start < tomorrow) {
      setError("当日不可下单，请选择明天或之后的日期");
      return;
    }

    onNext({
      order_id: initialData.order_id,
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10),
      departure_hotel: departureHotel,
      end_hotel: endHotel || departureHotel,
    });
  };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <h2 style={{ fontSize: 28, textAlign: "center", marginBottom: 8 }}>
        立即预订
      </h2>
      <p style={{ textAlign: "center", color: "#666", marginBottom: 24 }}>
        请选择您期望的包车开始和结束日期
      </p>

      <DayPicker
        mode="range"
        selected={range}
        onSelect={setRange}
        disabled={{ before: tomorrow }}
        numberOfMonths={2}
      />

      <div style={{ display: "flex", gap: 24, marginTop: 24 }}>
        <div style={{ flex: 1 }}>
          <label>出发酒店</label>
          <input
            value={departureHotel}
            onChange={(e) => setDepartureHotel(e.target.value)}
            style={{ width: "100%", padding: 10 }}
          />
        </div>

        <div style={{ flex: 1 }}>
          <label>回程酒店（可选）</label>
          <input
            value={endHotel}
            onChange={(e) => setEndHotel(e.target.value)}
            style={{ width: "100%", padding: 10 }}
          />
        </div>
      </div>

      {error && (
        <div style={{ color: "red", marginTop: 16 }}>{error}</div>
      )}

      <div style={{ textAlign: "right", marginTop: 24 }}>
        <button
          onClick={handleNext}
          style={{
            background: "#3f6df6",
            color: "#fff",
            border: "none",
            padding: "12px 28px",
            fontSize: 16,
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          下一步
        </button>
      </div>
    </div>
  );
}

