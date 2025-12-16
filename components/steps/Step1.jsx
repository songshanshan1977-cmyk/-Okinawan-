// Step1：日期 + 酒店
// ✅ 当日不能下单
// ✅ 校验日期是否存在库存（不看车型）
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
  const [loading, setLoading] = useState(false);

  // ⭐ 只按日期检查是否“存在库存记录”
  async function checkInventoryByDate(date) {
    const res = await fetch("/api/check-inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date }),
    });

    if (!res.ok) {
      throw new Error("库存检查失败");
    }

    return await res.json();
  }

  const handleNext = async () => {
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

    // ⭐ 库存校验（日期级）
    try {
      setLoading(true);

      const result = await checkInventoryByDate(startDate);

      if (!result.ok) {
        setError("该日期暂无可用车辆，请选择其他日期。");
        return;
      }

      // ✅ 通过，进入 Step2
      onNext({
        order_id: initialData.order_id, // 保证订单号不丢
        start_date: startDate,
        end_date: endDate || startDate,
        departure_hotel: departureHotel,
        end_hotel: endHotel || departureHotel,
      });
    } catch (err) {
      console.error(err);
      setError("库存检查失败，请稍后再试。");
    } finally {
      setLoading(false);
    }
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
          disabled={loading}
          style={{
            marginTop: "16px",
            padding: "10px 20px",
            background: loading ? "#94a3b8" : "#2563eb",
            color: "#fff",
            borderRadius: "6px",
            border: "none",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "检查库存中..." : "下一步：选择车型"}
        </button>
      </div>
    </div>
  );
}

