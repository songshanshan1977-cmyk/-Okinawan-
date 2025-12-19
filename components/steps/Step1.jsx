import { useMemo, useState, useEffect } from "react";
import { DayPicker } from "react-day-picker";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";

// ✅ 工具：把 Date -> "YYYY-MM-DD"
function toYMD(d) {
  if (!d) return "";
  return format(d, "yyyy-MM-dd");
}

// ✅ 工具：把 "YYYY-MM-DD" -> Date（避免时区乱跳）
function fromYMD(s) {
  if (!s) return null;
  // 用“本地日期”解析，避免 new Date("2025-12-19") 被当 UTC 导致前后差一天
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

// ✅ 工具：明天 00:00（稳定，不吃时区）
function getTomorrow() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const t = new Date(today);
  t.setDate(today.getDate() + 1);
  return t;
}

export default function Step1({ initialData, onNext }) {
  const [start, setStart] = useState(fromYMD(initialData.start_date) || null);
  const [end, setEnd] = useState(fromYMD(initialData.end_date) || null);

  const [departureHotel, setDepartureHotel] = useState(
    initialData.departure_hotel || ""
  );
  const [endHotel, setEndHotel] = useState(initialData.end_hotel || "");
  const [error, setError] = useState("");

  const tomorrow = useMemo(() => getTomorrow(), []);

  // ✅ 保证：end 永远不早于 start（允许等于）
  useEffect(() => {
    if (start && end && end < start) setEnd(start);
    if (start && !end) setEnd(start);
  }, [start]); // eslint-disable-line

  const disabledDays = useMemo(() => [{ before: tomorrow }], [tomorrow]);

  // ✅ 月份标题：2025年12月（不会出现 2025年14月）
  const formatCaption = (date) => format(date, "yyyy年M月", { locale: zhCN });

  // ✅ 周末红色（周六/周日）
  const isWeekend = (date) => {
    const day = date.getDay();
    return day === 0 || day === 6;
  };

  const handleNext = () => {
    setError("");

    if (!start) {
      setError("请选择用车开始日期");
      return;
    }
    if (!departureHotel) {
      setError("请输入出发酒店");
      return;
    }

    // ❌ 当日不能下单（start < 明天）
    const start0 = new Date(start);
    start0.setHours(0, 0, 0, 0);
    if (start0 < tomorrow) {
      setError("请选择明天或之后的日期");
      return;
    }

    const finalEnd = end || start;

    onNext({
      order_id: initialData.order_id,
      start_date: toYMD(start),
      end_date: toYMD(finalEnd),
      departure_hotel: departureHotel,
      end_hotel: (endHotel || departureHotel).trim(),
    });
  };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 16px" }}>
      {/* 简单内置样式：不依赖 tailwind / postcss */}
      <style>{`
        .calWrap{ display:flex; gap:56px; justify-content:center; margin: 22px 0 28px; }
        .calBox{ width: 360px; border:1px solid #ddd; background:#fff; }
        .calTitle{ text-align:center; font-weight:700; font-size:22px; margin-bottom:10px; }
        .fieldRow{ display:flex; gap:56px; justify-content:center; margin-top: 12px; }
        .field{ width: 520px; }
        .input{ width:100%; padding:14px 12px; font-size:16px; border:1px solid #e5e5e5; border-radius:6px; outline:none; }
        .btnRow{ display:flex; justify-content:flex-end; margin-top: 18px; }
        .btn{ background:#3f6df6; color:#fff; border:none; padding:14px 34px; font-size:18px; border-radius:8px; cursor:pointer; }
        .err{ color:#d00; margin-top: 10px; text-align:center; }
        /* DayPicker 极简“图1风格” */
        .rdp{ margin: 0; }
        .rdp-months{ justify-content:center; }
        .rdp-month{ width: 100%; }
        .rdp-caption{ display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:#f3f3f3; border-bottom:1px solid #ddd; }
        .rdp-caption_label{ font-weight:700; }
        .rdp-nav button{ border:1px solid #bbb; background:#fff; width:30px; height:30px; border-radius:4px; cursor:pointer; }
        .rdp-head{ border-bottom:1px solid #ddd; }
        .rdp-head_cell{ font-weight:700; padding:10px 0; }
        .rdp-cell{ padding:6px 0; }
        .rdp-day{ width:40px; height:40px; border-radius:0; }
        .rdp-day_selected{ background: #ffef6b !important; color:#000 !important; font-weight:700; }
        .rdp-day_disabled{ color:#bbb !important; }
      `}</style>

      <h2 style={{ fontSize: 34, textAlign: "center", marginBottom: 8 }}>
        立即预订
      </h2>
      <p style={{ textAlign: "center", color: "#666", marginBottom: 12 }}>
        请选择您期望的包车开始和结束日期
      </p>

      <div className="calWrap">
        <div style={{ textAlign: "center" }}>
          <div className="calTitle">开始日期</div>
          <div className="calBox">
            <DayPicker
              mode="single"
              selected={start}
              onSelect={(d) => setStart(d || null)}
              disabled={disabledDays}
              locale={zhCN}
              formatters={{ formatCaption }}
              weekStartsOn={1} // 周一开始（图1观感）
              modifiers={{
                weekend: (date) => isWeekend(date),
              }}
              modifiersStyles={{
                weekend: { color: "#d00" },
              }}
            />
          </div>
        </div>

        <div style={{ textAlign: "center" }}>
          <div className="calTitle">结束日期</div>
          <div className="calBox">
            <DayPicker
              mode="single"
              selected={end}
              onSelect={(d) => setEnd(d || null)}
              disabled={[
                ...disabledDays,
                start ? { before: start } : null, // ✅ 结束日期不能早于开始日期
              ].filter(Boolean)}
              locale={zhCN}
              formatters={{ formatCaption }}
              weekStartsOn={1}
              modifiers={{
                weekend: (date) => isWeekend(date),
              }}
              modifiersStyles={{
                weekend: { color: "#d00" },
              }}
            />
          </div>
        </div>
      </div>

      <div className="fieldRow">
        <div className="field">
          <label style={{ display: "block", marginBottom: 8 }}>出发酒店</label>
          <input
            className="input"
            type="text"
            value={departureHotel}
            onChange={(e) => setDepartureHotel(e.target.value)}
          />
        </div>

        <div className="field">
          <label style={{ display: "block", marginBottom: 8 }}>回程酒店</label>
          <input
            className="input"
            type="text"
            value={endHotel}
            onChange={(e) => setEndHotel(e.target.value)}
          />
        </div>
      </div>

      {error && <div className="err">{error}</div>}

      <div className="btnRow">
        <button className="btn" onClick={handleNext}>
          下一步
        </button>
      </div>
    </div>
  );
}





