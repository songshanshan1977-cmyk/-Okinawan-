import { useState } from "react";

function getMonthMatrix(year, month) {
  const firstDay = new Date(year, month, 1);
  const startDay = firstDay.getDay() || 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const matrix = [];
  let day = 1 - (startDay - 1);

  for (let i = 0; i < 6; i++) {
    const row = [];
    for (let j = 1; j <= 7; j++) {
      if (day < 1 || day > daysInMonth) {
        row.push(null);
      } else {
        row.push(new Date(year, month, day));
      }
      day++;
    }
    matrix.push(row);
  }
  return matrix;
}

function Calendar({ title, selected, onSelect }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());

  const matrix = getMonthMatrix(year, month);

  const isSameDay = (a, b) =>
    a && b && a.toDateString() === b.toDateString();

  return (
    <div style={{ border: "1px solid #ddd", padding: "12px" }}>
      <div style={{ textAlign: "center", marginBottom: "8px" }}>
        <button onClick={() => setMonth(month - 1)}>«</button>
        <strong style={{ margin: "0 12px" }}>
          {year}年{month + 1}月
        </strong>
        <button onClick={() => setMonth(month + 1)}>»</button>
      </div>

      <table style={{ width: "100%", textAlign: "center" }}>
        <thead>
          <tr>
            {["一", "二", "三", "四", "五", "六", "日"].map((d) => (
              <th key={d}>{d}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.map((row, i) => (
            <tr key={i}>
              {row.map((date, j) => {
                if (!date) return <td key={j}></td>;

                const disabled = date < today;
                const selectedDay = isSameDay(date, selected);

                return (
                  <td
                    key={j}
                    onClick={() => !disabled && onSelect(date)}
                    style={{
                      padding: "6px",
                      cursor: disabled ? "not-allowed" : "pointer",
                      background: selectedDay ? "#ffe066" : "",
                      color: disabled ? "#ccc" : "",
                    }}
                  >
                    {date.getDate()}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ textAlign: "center", marginTop: "6px" }}>{title}</div>
    </div>
  );
}

export default function Step1({ initialData, onNext }) {
  const [startDate, setStartDate] = useState(
    initialData.start_date ? new Date(initialData.start_date) : null
  );
  const [endDate, setEndDate] = useState(
    initialData.end_date ? new Date(initialData.end_date) : null
  );
  const [departureHotel, setDepartureHotel] = useState(
    initialData.departure_hotel || ""
  );
  const [endHotel, setEndHotel] = useState(
    initialData.end_hotel || ""
  );
  const [error, setError] = useState("");

  const handleNext = () => {
    if (!startDate) {
      setError("请选择用车开始日期");
      return;
    }
    if (!departureHotel) {
      setError("请输入出发酒店");
      return;
    }
    if (endDate && endDate < startDate) {
      setError("结束日期不能早于开始日期");
      return;
    }

    onNext({
      order_id: initialData.order_id,
      start_date: startDate.toISOString().slice(0, 10),
      end_date: (endDate || startDate).toISOString().slice(0, 10),
      departure_hotel: departureHotel,
      end_hotel: endHotel || departureHotel,
    });
  };

  return (
    <div style={{ maxWidth: "900px", margin: "0 auto" }}>
      <h2 style={{ textAlign: "center" }}>立即预订</h2>
      <p style={{ textAlign: "center", color: "#666" }}>
        请选择您期望的包车开始和结束日期
      </p>

      <div style={{ display: "flex", gap: "40px", margin: "24px 0" }}>
        <Calendar title="开始日期" selected={startDate} onSelect={setStartDate} />
        <Calendar title="结束日期" selected={endDate} onSelect={setEndDate} />
      </div>

      <div style={{ display: "flex", gap: "40px", marginBottom: "24px" }}>
        <input
          placeholder="出发酒店"
          value={departureHotel}
          onChange={(e) => setDepartureHotel(e.target.value)}
          style={{ flex: 1, padding: "10px" }}
        />
        <input
          placeholder="回程酒店"
          value={endHotel}
          onChange={(e) => setEndHotel(e.target.value)}
          style={{ flex: 1, padding: "10px" }}
        />
      </div>

      {error && <div style={{ color: "red" }}>{error}</div>}

      <div style={{ textAlign: "right" }}>
        <button onClick={handleNext} style={{ padding: "10px 24px" }}>
          下一步
        </button>
      </div>
    </div>
  );
}




