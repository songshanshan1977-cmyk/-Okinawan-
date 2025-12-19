// Step1：日期 + 酒店（使用 react-day-picker 展示型日历）
// 规则：
// 1️⃣ 当日不能下单（稳定，不受时区影响）
// 2️⃣ 结束日期不能早于开始日期（允许等于，表示 1 天游）
// 3️⃣ 页面不显示任何规则提示文字（只在 Next 时校验）

import { useState } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/dist/style.css";

export default function Step1({ initialData, onNext }) {
  const [range, setRange] = useState(() => {
    if (initialData.start_date) {
      return {
        from: new Date(initialData.start_date),
        to: initialData.end_date
          ? new Date(initialData.end_date)
          : new Date(initialData.start_date),
      };
    }
    return undefined;
  });

  const [departureHotel, setDepartureHotel] = useState(
    initialData.departure_hotel || ""
  );
  const [endHotel, setEndHotel] = useState(
    initialData.end_hotel || ""
  );
  const [error, setError] = useState("");

  // ✅ 稳定的“明天”
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const formatDate = (d) =>
    d.toISOString().slice(0, 10); // yyyy-mm-dd

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

    // ❌ 当日不能下单
    if (start < tomorrow) {
      setError("请选择明天或之后的日期");
      return;
    }

    // ❌ 结束日期不能早于开始日期（允许等于）
    if (end < start) {
      setError("结束日期不能早于开始日期");
      return;
    }

    onNext({
      order_id: initialData.order_id,
      start_date: formatDate(start),
      end_date: formatDate(end),
      departure_hotel: departureHotel,
      end_hotel: endHotel || departureHotel,
    });
  };

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: 24 }}>
      <h2 style={{ fontSize: 28, textAlign: "center", marginBottom: 8 }}>
        立即预订
      </h2>
      <p style={{ textAlign: "center", color: "#666", marginBottom: 32 }}>
        请选择您期望的包车开始和结束日期
      </p>

      {/* 📅 日历 */}
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 32 }}>
        <DayPicker
          mode="range"
          selected={range}
          onSelect={setRange}
          numberOfMonths={2}
          disabled={{ before: tomorrow }}
          modifiersStyles={{
            selected: {
              backgroundColor: "#3f6df6",
              color: "#fff",
            },
            range_middle: {
              backgroundColor: "#dbeafe",
            },
            disabled: {
              color: "#d11a2a",
            },
          }}
        />
      </div>

      {/* 酒店 */}
      <div style={{ display: "flex", gap: 40, marginBottom: 24 }}>
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
        <div style={{ color: "red", marginBottom: 16 }}>
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


