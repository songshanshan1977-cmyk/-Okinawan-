import { useState } from "react";

// 简单价格表（你之后可以再和 Supabase 价格表对齐）
const BASE_PRICES = {
  car1: 35000, // 经济 5 座
  car2: 45000, // 阿尔法 7 座
  car3: 55000, // 海狮 10 座
};

// ⭐ 车型 UUID（必须与 BookingFlow.jsx 完全一致）
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
  const [error, setError] = useState("");

  const calcPrice = (model, hours) => {
    if (!model) return 0;
    const base = BASE_PRICES[model] || 0;
    return hours === 10 ? Math.round(base * 1.2) : base;
  };

  const handleSelectCar = (model) => {
    const price = calcPrice(model, duration);
    setCarModel(model);
    setTotalPrice(price);
  };

  const handleDurationChange = (hours) => {
    const h = Number(hours);
    setDuration(h);
    const price = calcPrice(carModel, h);
    setTotalPrice(price);
  };

  const handleNext = () => {
    setError("");

    if (!carModel) {
      setError("请选择车型");
      return;
    }

    if (!totalPrice || totalPrice <= 0) {
      setError("价格计算异常，请重新选择车型或时长。");
      return;
    }

    // ⭐ 回传关键字段：order_id + car_model_id
    onNext({
      order_id: initialData.order_id, // ← 必须回传订单号
      car_model: carModel,
      car_model_id: CAR_MODEL_IDS[carModel], // ← 必须回传车型 UUID
      driver_lang: driverLang,
      duration,
      total_price: totalPrice,
    });
  };

  return (
    <div>
      <h2 style={{ fontSize: "24px", marginBottom: "16px" }}>
        Step2：选择车型 & 服务
      </h2>

      <div style={{ display: "flex", gap: "16px", marginBottom: "16px" }}>
        <button
          onClick={() => handleSelectCar("car1")}
          style={{
            padding: "12px",
            borderRadius: "8px",
            border: carModel === "car1" ? "2px solid #2563eb" : "1px solid #ddd",
            flex: 1,
          }}
        >
          <div>经济 5 座轿车</div>
          <div>参考价格：¥{BASE_PRICES.car1}</div>
        </button>

        <button
          onClick={() => handleSelectCar("car2")}
          style={{
            padding: "12px",
            borderRadius: "8px",
            border: carModel === "car2" ? "2px solid #2563eb" : "1px solid #ddd",
            flex: 1,
          }}
        >
          <div>豪华 7 座阿尔法</div>
          <div>参考价格：¥{BASE_PRICES.car2}</div>
        </button>

        <button
          onClick={() => handleSelectCar("car3")}
          style={{
            padding: "12px",
            borderRadius: "8px",
            border: carModel === "car3" ? "2px solid #2563eb" : "1px solid #ddd",
            flex: 1,
          }}
        >
          <div>舒适 10 座海狮</div>
          <div>参考价格：¥{BASE_PRICES.car3}</div>
        </button>
      </div>

      <div style={{ marginBottom: "12px" }}>
        <label>
          司机语言：
          <select
            value={driverLang}
            onChange={(e) => setDriverLang(e.target.value)}
            style={{ marginLeft: "8px", padding: "6px" }}
          >
            <option value="zh">中文司机</option>
            <option value="jp">日文司机</option>
          </select>
        </label>
      </div>

      <div style={{ marginBottom: "12px" }}>
        <label>
          包车时长：
          <select
            value={duration}
            onChange={(e) => handleDurationChange(e.target.value)}
            style={{ marginLeft: "8px", padding: "6px" }}
          >
            <option value={8}>8 小时</option>
            <option value={10}>10 小时</option>
          </select>
        </label>
      </div>

      <div style={{ marginTop: "8px", marginBottom: "8px" }}>
        当前总价：<strong>¥{totalPrice || 0}</strong>
      </div>

      {error && <div style={{ color: "red", marginBottom: "8px" }}>{error}</div>}

      <div style={{ display: "flex", gap: "8px" }}>
        <button
          onClick={onBack}
          style={{
            padding: "8px 16px",
            borderRadius: "6px",
            border: "1px solid #ccc",
            background: "#f3f4f6",
          }}
        >
          返回上一步
        </button>

        <button
          onClick={handleNext}
          style={{
            padding: "8px 16px",
            borderRadius: "6px",
            border: "none",
            background: "#2563eb",
            color: "#fff",
          }}
        >
          下一步：填写信息
        </button>
      </div>
    </div>
  );
}
