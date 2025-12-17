import { useState, useEffect } from "react";

// ⭐ 车型 UUID（保持不变）
const CAR_MODEL_IDS = {
  car1: "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca",
  car2: "82cf604f-e688-49fe-aecf-69894a01f6cb",
  car3: "453df662-d350-4ab9-b811-61ffcda40d4b",
};

// 统一 driver_lang：前端用 zh/jp，但后端表里你现在是 ZH/JP（从截图看到）
const normalizeLangForAPI = (lang) => {
  if (lang === "zh") return "ZH";
  if (lang === "jp") return "JP";
  return lang;
};

// yyyy-mm-dd
const formatDate = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export default function Step2({ initialData, onNext, onBack }) {
  const [carModel, setCarModel] = useState(initialData.car_model || "");
  const [driverLang, setDriverLang] = useState(initialData.driver_lang || "zh");
  const [duration, setDuration] = useState(initialData.duration || 8);
  const [totalPrice, setTotalPrice] = useState(initialData.total_price || 0);

  const [pax, setPax] = useState(initialData.pax ?? 1);
  const [luggage, setLuggage] = useState(initialData.luggage ?? 0);

  // ✅ 客户信息移到 Step2（邮箱必填）
  const [name, setName] = useState(initialData.name ?? "");
  const [phone, setPhone] = useState(initialData.phone ?? "");
  const [email, setEmail] = useState(initialData.email ?? "");
  const [remark, setRemark] = useState(initialData.remark ?? "");

  const [error, setError] = useState("");
  const [stockHint, setStockHint] = useState(null); // 用来显示 total_stock，方便你验证

  /**
   * 🔵 从后端 car_prices 表读取价格
   * - 兼容后端返回 { price: 2600 } 或 { price_rmb: 2600 }
   * - 字段名用 duration_hours（你确认的真实字段名）
   */
  const fetchPrice = async (modelKey, lang, hours) => {
    if (!modelKey) return 0;

    const res = await fetch("/api/get-car-price", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        car_model_id: CAR_MODEL_IDS[modelKey],
        driver_lang: normalizeLangForAPI(lang),
        duration_hours: Number(hours),
        date: initialData.start_date, // 预留将来节假日价/区间价用
      }),
    });

    if (!res.ok) return 0;

    const data = await res.json();

    // ✅ 关键修复：你的接口响应里现在是 { "price": 2600 }
    const p = Number(data?.price ?? data?.price_rmb ?? 0);
    return Number.isFinite(p) ? p : 0;
  };

  // ⭐ 车型 / 语言 / 时长 任一变化 → 重新拉价格
  useEffect(() => {
    const run = async () => {
      setError("");
      setTotalPrice(0);
      if (!carModel) return;

      const price = await fetchPrice(carModel, driverLang, duration);
      setTotalPrice(price);
      if (!price) {
        setError("价格读取失败，请稍后重试。");
      }
    };
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carModel, driverLang, duration]);

  // 🔴 库存检查（保持走 /api/check-inventory）
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

    // ✅ 兜底：当日不能预约（防止 Step1 失效）
    const today = formatDate(new Date());
    if (initialData.start_date === today) {
      setError("当日不能预约，请选择明天或之后的日期。");
      return;
    }

    if (!carModel) {
      setError("请选择车型");
      return;
    }

    // 客户信息（邮箱必填）
    if (!name.trim()) {
      setError("请输入姓名（必填）");
      return;
    }
    if (!phone.trim()) {
      setError("请输入电话（必填）");
      return;
    }
    if (!email.trim()) {
      setError("请输入邮箱（必填）");
      return;
    }

    if (!totalPrice || totalPrice <= 0) {
      setError("价格读取失败，请稍后重试。");
      return;
    }

    const inv = await checkInventory();
    setStockHint(inv.total_stock);

    if (!inv.ok) {
      setError("该日期该车型已无库存，请选择其他车型或日期。");
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

      // ✅ 客户信息放到 Step2 里往后传
      name: name.trim(),
      phone: phone.trim(),
      email: email.trim(),
      remark: remark ?? "",
    });
  };

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: 16 }}>
      <h2 style={{ fontSize: 24, marginBottom: 16 }}>Step2：选择车型 & 服务</h2>

      {/* 车型 */}
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        {["car1", "car2", "car3"].map((m) => (
          <button
            key={m}
            onClick={() => setCarModel(m)}
            style={{
              padding: 12,
              borderRadius: 10,
              border: carModel === m ? "2px solid #2563eb" : "1px solid #ddd",
              background: carModel === m ? "#eff6ff" : "#f7f7f7",
              flex: 1,
              cursor: "pointer",
            }}
          >
            <div style={{ fontWeight: 700 }}>
              {m === "car1" && "经济 5 座轿车"}
              {m === "car2" && "豪华 7 座阿尔法"}
              {m === "car3" && "舒适 10 座海狮"}
            </div>
          </button>
        ))}
      </div>

      {/* 司机语言 / 时长 / 人数行李 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ width: 80 }}>司机语言：</span>
          <select value={driverLang} onChange={(e) => setDriverLang(e.target.value)}>
            <option value="zh">中文司机</option>
            <option value="jp">日文司机</option>
          </select>
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ width: 80 }}>包车时长：</span>
          <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            <option value={8}>8 小时</option>
            <option value={10}>10 小时</option>
          </select>
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ width: 80 }}>人数：</span>
          <select value={pax} onChange={(e) => setPax(e.target.value)}>
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ width: 80 }}>行李：</span>
          <select value={luggage} onChange={(e) => setLuggage(e.target.value)}>
            {Array.from({ length: 11 }, (_, i) => i).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* 客户信息 */}
      <div style={{ marginTop: 8, marginBottom: 12, padding: 12, border: "1px solid #eee", borderRadius: 10 }}>
        <div style={{ fontWeight: 800, marginBottom: 10 }}>客户信息</div>

        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 10, alignItems: "center" }}>
          <div>姓名（必填）：</div>
          <input value={name} onChange={(e) => setName(e.target.value)} />

          <div>电话（必填）：</div>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} />

          <div>邮箱（必填）：</div>
          <input value={email} onChange={(e) => setEmail(e.target.value)} />

          <div>备注（可选）：</div>
          <input value={remark} onChange={(e) => setRemark(e.target.value)} />
        </div>
      </div>

      <div style={{ marginBottom: 8 }}>
        当前总价：<strong>¥{totalPrice}</strong>
        {typeof stockHint === "number" && (
          <span style={{ marginLeft: 12, color: "#666" }}>（库存汇总：{stockHint}）</span>
        )}
      </div>

      {error && <div style={{ color: "red", marginBottom: 10 }}>{error}</div>}

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onBack}>返回上一步</button>
        <button onClick={handleNext}>下一步：填写信息</button>
      </div>
    </div>
  );
}


