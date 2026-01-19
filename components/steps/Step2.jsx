import { useState, useEffect } from "react";

// ⭐ 车型 UUID（保持不变）
const CAR_MODEL_IDS = {
  car1: "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca",
  car2: "82cf604f-e688-49fe-aecf-69894a01f6cb",
  car3: "453df662-d350-4ab9-b811-61ffcda40d4b",
};

// 前端 zh/jp → 后端 ZH/JP
const normalizeLangForAPI = (lang) => {
  if (lang === "zh") return "ZH";
  if (lang === "jp") return "JP";
  return lang;
};

const formatDate = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const calcDays = (start, end) => {
  const s = new Date(start);
  const e = new Date(end || start);
  return Math.floor((e - s) / (1000 * 60 * 60 * 24)) + 1;
};

export default function Step2({ initialData, onNext, onBack }) {
  const [carModel, setCarModel] = useState(initialData.car_model || "");
  const [driverLang, setDriverLang] = useState(initialData.driver_lang || "zh");
  const [duration, setDuration] = useState(initialData.duration || 8);
  const [totalPrice, setTotalPrice] = useState(initialData.total_price || 0);

  const [pax, setPax] = useState(initialData.pax ?? 1);
  const [luggage, setLuggage] = useState(initialData.luggage ?? 0);

  const [name, setName] = useState(initialData.name ?? "");
  const [phone, setPhone] = useState(initialData.phone ?? "");
  const [email, setEmail] = useState(initialData.email ?? "");

  // ✅ 已有：行程（可选）
  const [itinerary, setItinerary] = useState(initialData.itinerary ?? "");

  // ✅ 只新增：微信（可选）—— 放在电话下面
  const [wechat, setWechat] = useState(initialData.wechat ?? "");

  const [remark, setRemark] = useState(initialData.remark ?? "");

  const [error, setError] = useState("");
  const [stockHint, setStockHint] = useState(null);

  const fetchDailyPrice = async (modelKey, lang, hours) => {
    if (!modelKey || !initialData.start_date) return null;

    const params = new URLSearchParams({
      car_model_id: CAR_MODEL_IDS[modelKey],
      driver_lang: normalizeLangForAPI(lang),
      duration_hours: String(hours),
      use_date: initialData.start_date,
    });

    const res = await fetch(`/api/get-car-price?${params.toString()}`);
    if (!res.ok) return null;

    const data = await res.json();
    return Number(data?.price ?? 0);
  };

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setError("");
      if (!carModel) return;

      const dailyPrice = await fetchDailyPrice(carModel, driverLang, duration);
      if (cancelled) return;

      if (dailyPrice > 0) {
        const days = calcDays(initialData.start_date, initialData.end_date);
        setTotalPrice(dailyPrice * days);
      } else {
        setTotalPrice(0);
        setError("价格读取失败，请稍后重试。");
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [carModel, driverLang, duration, initialData.start_date, initialData.end_date]);

  const checkInventory = async () => {
    const res = await fetch("/api/check-inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: initialData.start_date,
        car_model_id: CAR_MODEL_IDS[carModel],
      }),
    });

    if (!res.ok) return { ok: false, total_stock: 0 };
    const data = await res.json();
    return {
      ok: data?.ok === true,
      total_stock: Number(data?.total_stock ?? 0),
    };
  };

  const handleNext = async () => {
    setError("");
    setStockHint(null);

    const today = formatDate(new Date());
    if (initialData.start_date === today) {
      setError("当日不能预约，请选择明天或之后的日期。");
      return;
    }

    if (!carModel) return setError("请选择车型");
    if (!name.trim()) return setError("请输入姓名（必填）");
    if (!phone.trim()) return setError("请输入电话（必填）");
    if (!email.trim()) return setError("请输入邮箱（必填）");
    if (!totalPrice || totalPrice <= 0) return setError("价格读取失败，请稍后重试。");

    const inv = await checkInventory();
    setStockHint(inv.total_stock);

    if (!inv.ok) {
      setError("NO_STOCK");
      return;
    }

    onNext({
      order_id: initialData.order_id,
      car_model: carModel,
      car_model_id: CAR_MODEL_IDS[carModel],
      driver_lang: driverLang,
      duration,
      total_price: totalPrice,
      pax: Number(pax),
      luggage: Number(luggage),
      name: name.trim(),
      phone: phone.trim(),

      // ✅ 只新增：把微信带到下一步（可选）
      wechat: wechat ?? "",

      email: email.trim(),

      // ✅ 已有：把行程带到下一步（可选）
      itinerary: itinerary ?? "",

      remark: remark ?? "",
    });
  };

  const box = {
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    padding: 16,
    background: "#fff",
  };

  const input = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #d1d5db",
    fontSize: 14,
  };

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: 20 }}>
      <h2 style={{ fontSize: 26, marginBottom: 20 }}>Step2：选择车型 & 服务</h2>

      {/* 车型 */}
      <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
        {["car1", "car2", "car3"].map((m) => (
          <div
            key={m}
            onClick={() => setCarModel(m)}
            style={{
              flex: 1,
              padding: 16,
              borderRadius: 16,
              border: carModel === m ? "2px solid #2563eb" : "1px solid #e5e7eb",
              background: carModel === m ? "#eff6ff" : "#f9fafb",
              cursor: "pointer",
              textAlign: "center",
              fontWeight: 600,
            }}
          >
            {m === "car1" && "经济 5 座轿车"}
            {m === "car2" && "豪华 7 座阿尔法"}
            {m === "car3" && "舒适 10 座海狮"}
          </div>
        ))}
      </div>

      {/* 参数 */}
      <div style={{ ...box, marginBottom: 20 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, 1fr)",
            gap: 16,
          }}
        >
          <div>
            <label>司机语言</label>
            <select
              style={input}
              value={driverLang}
              onChange={(e) => setDriverLang(e.target.value)}
            >
              <option value="zh">中文司机</option>
              <option value="jp">日文司机</option>
            </select>
          </div>

          <div>
            <label>包车时长</label>
            <select
              style={input}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            >
              <option value={8}>8 小时</option>
              <option value={10}>10 小时</option>
            </select>
          </div>

          <div>
            <label>人数</label>
            <select
              style={input}
              value={pax}
              onChange={(e) => setPax(e.target.value)}
            >
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label>行李</label>
            <select
              style={input}
              value={luggage}
              onChange={(e) => setLuggage(e.target.value)}
            >
              {Array.from({ length: 11 }, (_, i) => i).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* 客户信息 */}
      <div style={{ ...box, marginBottom: 20 }}>
        <strong style={{ display: "block", marginBottom: 12 }}>客户信息</strong>

        <div style={{ display: "grid", gap: 12 }}>
          <input
            style={input}
            placeholder="姓名（必填）"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            style={input}
            placeholder="电话（必填）"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />

          {/* ✅ 只新增：微信（可选）放在电话下面 */}
          <input
            style={input}
            placeholder="微信（可选）"
            value={wechat}
            onChange={(e) => setWechat(e.target.value)}
          />

          {/* ✅✅ 方案一：邮箱输入框下面加提示（不影响输入，一直可见） */}
          <div style={{ display: "grid", gap: 6 }}>
            <input
              style={input}
              placeholder="邮箱（必填）"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <div style={{ fontSize: 12, color: "#6b7280" }}>
              请填写正确邮箱，付款成功后将发送订单确认邮件
            </div>
          </div>

          {/* ✅ 已有：行程（可选） */}
          <input
            style={input}
            placeholder="行程（可选）"
            value={itinerary}
            onChange={(e) => setItinerary(e.target.value)}
          />

          <input
            style={input}
            placeholder="备注（可选）"
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
          />
        </div>
      </div>

      {/* 总价 */}
      <div style={{ fontSize: 18, marginBottom: 8 }}>
        当前总价：<strong>¥{totalPrice}</strong>
        {typeof stockHint === "number" && (
          <span style={{ marginLeft: 12, color: "#6b7280" }}>
            （库存：{stockHint}）
          </span>
        )}
      </div>

      {/* A + B：库存不可用提示块 */}
      {error === "NO_STOCK" && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            padding: "12px 14px",
            borderRadius: 10,
            marginBottom: 16,
            fontSize: 14,
          }}
        >
          <strong>该日期该车型暂无车辆</strong>
          <div style={{ marginTop: 4 }}>
            请尝试更换其他车型，或返回上一步修改用车日期。
          </div>
        </div>
      )}

      {error && error !== "NO_STOCK" && (
        <div style={{ color: "#dc2626", marginBottom: 12 }}>{error}</div>
      )}

      <div style={{ display: "flex", gap: 12 }}>
        <button onClick={onBack}>返回上一步</button>
        <button onClick={handleNext}>下一步：填写信息</button>
      </div>
    </div>
  );
}

