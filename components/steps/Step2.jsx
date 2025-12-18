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
  const [remark, setRemark] = useState(initialData.remark ?? "");

  const [error, setError] = useState("");

  /**
   * 🔵 读取价格（只按 车型 + 语言 + 时长）
   */
  const fetchPrice = async () => {
    if (!carModel) return;

    setError("");

    const res = await fetch("/api/get-car-price", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        car_model_id: CAR_MODEL_IDS[carModel],
        driver_lang: normalizeLangForAPI(driverLang),
        duration_hours: Number(duration),
      }),
    });

    if (!res.ok) {
      setTotalPrice(0);
      setError("价格读取失败，请稍后重试");
      return;
    }

    const data = await res.json();
    const price = Number(data?.price ?? 0);

    if (price > 0) {
      setTotalPrice(price);
    } else {
      setTotalPrice(0);
      setError("价格读取失败，请稍后重试");
    }
  };

  // ✅ 只有这三个变化才拉价格
  useEffect(() => {
    fetchPrice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carModel, driverLang, duration]);

  const handleNext = () => {
    setError("");

    if (!carModel) return setError("请选择车型");
    if (!name.trim()) return setError("请输入姓名");
    if (!phone.trim()) return setError("请输入电话");
    if (!email.trim()) return setError("请输入邮箱");
    if (!totalPrice || totalPrice <= 0)
      return setError("价格读取失败，请稍后重试");

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
      email: email.trim(),
      remark: remark ?? "",
    });
  };

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: 16 }}>
      <h2>Step2：选择车型 & 服务</h2>

      <div style={{ display: "flex", gap: 12 }}>
        {["car1", "car2", "car3"].map((m) => (
          <button
            key={m}
            onClick={() => setCarModel(m)}
            style={{
              flex: 1,
              padding: 12,
              border:
                carModel === m ? "2px solid #2563eb" : "1px solid #ddd",
            }}
          >
            {m === "car1" && "经济 5 座轿车"}
            {m === "car2" && "豪华 7 座阿尔法"}
            {m === "car3" && "舒适 10 座海狮"}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 12 }}>
        司机语言：
        <select value={driverLang} onChange={(e) => setDriverLang(e.target.value)}>
          <option value="zh">中文司机</option>
          <option value="jp">日文司机</option>
        </select>
      </div>

      <div style={{ marginTop: 12 }}>
        包车时长：
        <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
          <option value={8}>8 小时</option>
          <option value={10}>10 小时</option>
        </select>
      </div>

      <div style={{ marginTop: 12 }}>
        当前总价：<strong>¥{totalPrice}</strong>
      </div>

      {error && <div style={{ color: "red" }}>{error}</div>}

      <div style={{ marginTop: 16 }}>
        <button onClick={onBack}>返回上一步</button>
        <button onClick={handleNext}>下一步</button>
      </div>
    </div>
  );
}


