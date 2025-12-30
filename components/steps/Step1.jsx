import { useMemo, useState, useEffect } from "react";
import { DayPicker } from "react-day-picker";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";

/* ===== 工具函数 ===== */

// Date -> YYYY-MM-DD
function toYMD(d) {
  if (!d) return "";
  return format(d, "yyyy-MM-dd");
}

// YYYY-MM-DD -> Date（本地解析，避免时区跳日）
function fromYMD(s) {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

// 明天 00:00（稳定）
function getTomorrow() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const t = new Date(today);
  t.setDate(today.getDate() + 1);
  return t;
}

export default function Step1({ initialData, onNext }) {
  const [start, setStart] = useState(fromYMD(initialData.start_date));
  const [end, setEnd] = useState(fromYMD(initialData.end_date));

  const [departureHotel, setDepartureHotel] = useState(
    initialData.departure_hotel || ""
  );
  const [endHotel, setEndHotel] = useState(
    initialData.end_hotel || ""
  );

  const [error, setError] = useState("");

  const tomorrow = useMemo(() => getTomorrow(), []);

  // ✅ 只保证：结束日期不能早于开始日期（不自动同步）
  useEffect(() => {
    if (start && end && end < start) {
      setEnd(null);
    }
  }, [start, end]);

  const disabledDays = useMemo(() => [{ before: tomorrow }], [tomorrow]);

  const formatCaption = (date) =>
    format(date, "yyyy年M月", { locale: zhCN });

  const isWeekend = (date) => {
    const d = date.getDay();
    return d === 0 || d === 6;
  };

  const handleNext = () => {
    setError("");

    if (!start) {
      setError("请选择用车开始日期");
      return;
    }
    if (!end) {
      setError("请选择用车结束日期");
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

    const start0 = new Date(start);
    start0.setHours(0, 0, 0, 0);
    if (start0 < tomorrow) {
      setError("请选择明天或之后的日期");
      return;
    }

    onNext({
      order_id: initialData.order_id,
      start_date: toYMD(start),
      end_date: toYMD(end),
      departure_hotel: departureHotel.trim(),
      end_hotel: endHotel.trim(),
    });
  };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 16px" }}>
      <style>{`
        .calWrap{
          display:flex;
          gap:56px;
          justify-content:center;
          margin: 22px 0 28px;
        }

        /* ⭐ 关键修改点：左右留白更均匀 */
        .calBox{
          width:360px;
          padding:12px;
          box-sizing:border-box;
          border:1px solid #ddd;
          background:#fff;
          border-radius:8px;
        }

        .calTitle{
          text-align:center;
          font-weight:700;
          font-size:22px;
          margin-bottom:10px;
        }

        .fieldRow{
          display:flex;
          gap:56px;
          justify-content:center;
          margin-top: 12px;
        }

        .field{ width:520px; }

        .input{
          width:100%;
          padding:14px 12px;
          font-size:16px;
          border:1px solid #e5e5e5;
          border-radius:6px;
          outline:none;
        }

        .btnRow{
          display:flex;
          justify-content:flex-end;
          margin-top: 18px;
        }

        .btn{
          background:#3f6df6;
          color:#fff;
          border:none;
          padding:14px 34px;
          font-size:18px;
          border-radius:8px;
          cursor:pointer;
        }

        .err{
          color:#d00;
          margin-top: 12px;
          text-align:center;
        }

        /* ===== DayPicker 视觉优化 ===== */

        .rdp{ margin:0; }
        .rdp-month{ width:100%; }
        .rdp-table{ margin:0 auto; } /* ⭐ 居中关键 */

        .rdp-caption{
          display:flex;
          align-items:center;
          justify-content:space-between;
          padding:10px 12px;
          background:#f3f3f3;
          border-bottom:1px solid #ddd;
        }

        .rdp-caption_label{ font-weight:700; }

        .rdp-nav button{
          border:1px solid #bbb;
          background:#fff;
          width:30px;
          height:30px;
          border-radius:6px;
          cursor:pointer;
        }

        .rdp-head{ border-bottom:1px solid #ddd; }
        .rdp-head_cell{ font-weight:700; padding:10px 0; }

        .rdp-cell{ padding:4px; }

        .rdp-day{
          width:40px;
          height:40px;
          border:1px solid #e6e6e6;
          border-radius:6px;
        }

        .rdp-day_selected{
          background:#fff3a0 !important;
          color:#000 !important;
          font-weight:700;
        }

        .rdp-day_disabled{
          color:#bbb !important;
        }
      `}</style>

      <h2 style={{ fontSize: 34, textAlign: "center", marginBottom: 8 }}>
        立即预订
      </h2>
      <p style={{ textAlign: "center", color: "#666", marginBottom: 12 }}>
        请选择您期望的包车开始和结束日期
      </p>

      <div className="calWrap">
        <div>
          <div className="calTitle">开始日期</div>
          <div className="calBox">
            <DayPicker
              mode="single"
              selected={start}
              onSelect={(d) => setStart(d || null)}
              disabled={disabledDays}
              locale={zhCN}
              formatters={{ formatCaption }}
              weekStartsOn={1}
              modifiers={{ weekend: isWeekend }}
              modifiersStyles={{ weekend: { color: "#d00" } }}
            />
          </div>
        </div>

        <div>
          <div className="calTitle">结束日期</div>
          <div className="calBox">
            <DayPicker
              mode="single"
              selected={end}
              onSelect={(d) => setEnd(d || null)}
              disabled={[
                ...disabledDays,
                start ? { before: start } : null,
              ].filter(Boolean)}
              locale={zhCN}
              formatters={{ formatCaption }}
              weekStartsOn={1}
              modifiers={{ weekend: isWeekend }}
              modifiersStyles={{ weekend: { color: "#d00" } }}
            />
          </div>
        </div>
      </div>

      {/* ===== ⭐ 新增：日历颜色/规则说明（仅展示，不改逻辑） ===== */}
      <div style={{ maxWidth: 760, margin: "0 auto", textAlign: "center" }}>
        <div className="text-sm text-gray-600 mt-2 space-y-1">
          <div>🟢 Green: In stock for the same day, reservations are available.</div>
          <div>🔴 Red: Fully booked for the day, no reservations available.</div>
          <div>🔵 Blue: Currently selected travel dates</div>
        </div>

        <div className="text-orange-600 mt-2">
          ⚠️ Multi-day car rentals require availability for all dates.
        </div>
      </div>
      {/* ===== 新增结束 ===== */}

      <div className="fieldRow">
        <div className="field">
          <label style={{ display: "block", marginBottom: 8 }}>
            出发酒店
          </label>
          <input
            className="input"
            value={departureHotel}
            onChange={(e) => setDepartureHotel(e.target.value)}
          />
        </div>

        <div className="field">
          <label style={{ display: "block", marginBottom: 8 }}>
            回程酒店
          </label>
          <input
            className="input"
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

