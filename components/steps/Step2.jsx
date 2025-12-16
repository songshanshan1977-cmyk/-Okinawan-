import { useState, useEffect } from "react";

// ⭐ 车型 UUID（保持不变）
const CAR_MODEL_IDS = {
  car1: "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca",
  car2: "82cf604f-e688-49fe-aecf-69894a01f6cb",
  car3: "453df662-d350-4ab9-b811-61ffcda40d4b",
};

export default function Step2({ initialData, onNext, onBack }) {
  const [carModel, setCarModel] = useState(initialData.car_model || "");
  const [driverLang, setDriverLang] = useState(initialData.driver_lang || "zh");
  const [duration, setDuration] = useState(initialData.duration || 8);
  const [totalPrice, setTotalPrice] = useState(initialData.total_price || 0);

  const [pax, setPax] = useState(initialData.pax ?? 1);
  const [luggage, setLuggage] = useState(initialData.luggage ?? 0);
  const [error, setError] = useState("");

  // 🔵 从后端读取价格
  const fetchPrice = async (modelKey, lang, hours) => {
    if (!modelKey) return 0;

    const res = await fetch("/api/get-car-price", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        car_model_id: CAR_MODEL_IDS[modelKey],
        driver_lang: lang,
        duration: hours,
      }),
    });

    if (!res.ok) return 0;
    const data = await res.json();
    return data.price || 0;
  };

  // ⭐ 车型 / 语言 / 时长 任一变化 → 重算价格
  useEffect(() => {
    const run = async () => {
      if (!carModel) return;
      const price = await fetchPrice(carModel, driverLang, duration);
      setTotalPrice(price);
    };
    run();
  }, [carModel, driverLang, duration]);

  // 🔴 库存检查（你现在这个是对的）
  const checkInventory = async () => {
    const res = await fetch("/api/check-inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: initialData.start_date,
        car_model_id: CAR_MODEL_IDS[carModel],
      }),
    });

    if (!res.ok) return false;
    const data = await res.json();
    return data?.ok === true;
  };

  const handleNext = async () => {
    setError("");

    if (!carModel) {
      setError("请选择车型");
      return;
    }

    if (!totalPrice || totalPrice <= 0) {
      setError("价格读取失败，请稍后重试。");
      return;
    }

    const ok = await checkInventory();
    if (!ok) {
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
    });
  };

  return (
    <div>
      <h2 style={{ fontSize: 24, marginBottom: 16 }}>
        Step2：选择车型 & 服务
      </h2>

      <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
        {["car1", "car2", "car3"].map((m) => (
          <button
            key={m}
            onClick={() => setCarModel(m)}
            style={{
              padding: 12,
              borderRadius: 8,
              border: carModel === m ? "2px solid #2563eb" : "1px solid #ddd",
              flex: 1,
            }}
          >
            {m === "car1" && "经济 5 座轿车"}
            {m === "car2" && "豪华 7 座阿尔法"}
            {m === "car3" && "舒适 10 座海狮"}
          </button>
        ))}
      </div>

      <div>
        司机语言：
        <select value={driverLang} onChange={(e) => setDriverLang(e.target.value)}>
          <option value="zh">中文司机</option>
          <option value="jp">日文司机</option>
        </select>
      </div>

      <div>
        包车时长：
        <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
          <option value={8}>8 小时</option>
          <option value={10}>10 小时</option>
        </select>
      </div>

      <div>
        人数：
        <select value={pax} onChange={(e) => setPax(e.target.value)}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>

        行李：
        <select value={luggage} onChange={(e) => setLuggage(e.target.value)}>
          {Array.from({ length: 11 }, (_, i) => i).map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </div>

      <div>当前总价：<strong>¥{totalPrice}</strong></div>

      {error && <div style={{ color: "red" }}>{error}</div>}

      <button onClick={onBack}>返回上一步</button>
      <button onClick={handleNext}>下一步：填写信息</button>
    </div>
  );
}

