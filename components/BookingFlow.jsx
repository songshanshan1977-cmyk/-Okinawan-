import { useState, useEffect } from "react"; // ⭐ NEW：引入 useEffect
import Step1 from "./steps/Step1";
import Step2 from "./steps/Step2";
import Step3 from "./steps/Step3";
import Step4Payment from "./steps/Step4Payment";
import Step5Confirmation from "./steps/Step5Confirmation";
import Step6Final from "./steps/Step6Final";

// ⭐ Supabase 车型表 UUID 映射（保持一致）
const CAR_MODEL_IDS = {
  car1: "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca",
  car2: "82cf604f-e688-49fe-aecf-69894a01f6cb",
  car3: "453df662-d350-4ab9-b811-61ffcda40d4b",
};

// ⭐ 订单编号生成（统一标准：ORD-YYYYMMDD-随机5位）
function generateOrderId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = Math.floor(10000 + Math.random() * 90000);
  return `ORD-${date}-${random}`;
}

export default function BookingFlow() {
  const [step, setStep] = useState(1);

  // ⭐ 全局表单数据（与你确认的 orders 表字段对齐）
  const [formData, setFormData] = useState(() => ({
    order_id: generateOrderId(),

    // Step1
    start_date: "",
    end_date: "",
    departure_hotel: "",
    end_hotel: "",

    // Step2
    car_model: "",
    car_model_id: "",
    driver_lang: "zh",
    duration: 8,
    total_price: 0,

    // Step3（客人信息）
    name: "",
    phone: "",
    email: "",
    remark: "",

    // 后端需要的字段
    deposit_amount: 500,
    pax: 1,
    luggage: 0,
    source: "direct",
  }));

  // =================================================
  // ⭐⭐⭐ NEW：从 Stripe success_url 恢复 step（关键补丁）
  // =================================================
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const stepFromUrl = params.get("step");
    const orderIdFromUrl = params.get("order_id");

    if (stepFromUrl === "5" && orderIdFromUrl) {
      console.log("🔁 Stripe 回跳，显示 Step5", orderIdFromUrl);
      setStep(5);
    }

    if (stepFromUrl === "4") {
      setStep(4);
    }
  }, []);

  // ⭐ 更新数据 & 自动填充车型 UUID
  const updateFormData = (patch) => {
    setFormData((prev) => {
      const next = { ...prev, ...patch };

      if (patch.car_model) {
        next.car_model_id = CAR_MODEL_IDS[patch.car_model] || "";
      }

      return next;
    });
  };

  // =================================================
  // ⭐ Step1 → Step2
  // =================================================
  const handleStep1Next = (values) => {
    if (
      !values.start_date ||
      !values.end_date ||
      !values.departure_hotel ||
      !values.end_hotel
    ) {
      alert("请填写完整：日期 / 出发酒店 / 回程酒店");
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    if (values.start_date === today) {
      alert("当天无法预约，请选择明天及之后的日期");
      return;
    }

    updateFormData(values);
    setStep(2);
  };

  // =================================================
  // ⭐ Step2 → Step3
  // =================================================
  const handleStep2Next = (values) => {
    const safeValues = {
      ...values,
      pax:
        values.pax !== undefined && values.pax !== null
          ? Number(values.pax)
          : formData.pax,
      luggage:
        values.luggage !== undefined && values.luggage !== null
          ? Number(values.luggage)
          : formData.luggage,
    };

    updateFormData(safeValues);
    setStep(3);
  };

  // ⭐ Step3 → Step4
  const handleStep3Next = (values) => {
    updateFormData(values);
    setStep(4);
  };

  // ⭐ Step4 支付成功（仅供非 Stripe 回跳场景兜底）
  const handlePaymentSuccess = async () => {
    try {
      await fetch("/api/update-order-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          order_id: formData.order_id,
          car_model_id: formData.car_model_id,
          start_date: formData.start_date,
          end_date: formData.end_date,
        }),
      });
    } catch (err) {
      console.error("更新订单或扣库存失败：", err);
    }

    setStep(5);
  };

  const handleStep5Next = () => setStep(6);
  const handleBack = () => setStep((s) => Math.max(1, s - 1));

  // ⭐ 渲染组件
  return (
    <div style={{ padding: "24px", maxWidth: "960px", margin: "0 auto" }}>
      {step === 1 && <Step1 initialData={formData} onNext={handleStep1Next} />}

      {step === 2 && (
        <Step2
          initialData={formData}
          onNext={handleStep2Next}
          onBack={handleBack}
        />
      )}

      {step === 3 && (
        <Step3
          initialData={formData}
          onNext={handleStep3Next}
          onBack={handleBack}
        />
      )}

      {step === 4 && (
        <Step4Payment
          initialData={formData}
          onBack={handleBack}
          onPaymentSuccess={handlePaymentSuccess}
        />
      )}

      {step === 5 && (
        <Step5Confirmation
          initialData={formData}
          onNext={handleStep5Next}
          onBack={handleBack}
        />
      )}

      {step === 6 && <Step6Final initialData={formData} />}
    </div>
  );
}


