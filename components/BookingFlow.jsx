import { useState, useEffect } from "react";
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

// ⭐ 订单编号生成
function generateOrderId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = Math.floor(10000 + Math.random() * 90000);
  return `ORD-${date}-${random}`;
}

export default function BookingFlow() {
  // ⭐⭐⭐ 关键修复：step 初始化直接读 URL ⭐⭐⭐
  const [step, setStep] = useState(() => {
    if (typeof window === "undefined") return 1;
    const params = new URLSearchParams(window.location.search);
    const stepFromUrl = params.get("step");
    return stepFromUrl ? Number(stepFromUrl) : 1;
  });

  const [formData, setFormData] = useState(() => ({
    order_id: generateOrderId(),

    start_date: "",
    end_date: "",
    departure_hotel: "",
    end_hotel: "",

    car_model: "",
    car_model_id: "",
    driver_lang: "zh",
    duration: 8,
    total_price: 0,

    name: "",
    phone: "",
    email: "",
    remark: "",

    deposit_amount: 500,
    pax: 1,
    luggage: 0,
    source: "direct",
  }));

  // ⭐ 保留 useEffect，仅用于日志 & 兜底
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const stepFromUrl = params.get("step");
    const orderIdFromUrl = params.get("order_id");

    if (stepFromUrl === "5") {
      console.log("✅ URL step=5 生效", orderIdFromUrl);
    }
  }, []);

  /* 下面所有逻辑完全不动 */

  const updateFormData = (patch) => {
    setFormData((prev) => {
      const next = { ...prev, ...patch };
      if (patch.car_model) {
        next.car_model_id = CAR_MODEL_IDS[patch.car_model] || "";
      }
      return next;
    });
  };

  const handleStep1Next = (values) => {
    updateFormData(values);
    setStep(2);
  };

  const handleStep2Next = (values) => {
    updateFormData(values);
    setStep(3);
  };

  const handleStep3Next = (values) => {
    updateFormData(values);
    setStep(4);
  };

  const handlePaymentSuccess = () => setStep(5);
  const handleStep5Next = () => setStep(6);
  const handleBack = () => setStep((s) => Math.max(1, s - 1));

  return (
    <div style={{ padding: "24px", maxWidth: "960px", margin: "0 auto" }}>
      {step === 1 && <Step1 initialData={formData} onNext={handleStep1Next} />}
      {step === 2 && <Step2 initialData={formData} onNext={handleStep2Next} />}
      {step === 3 && <Step3 initialData={formData} onNext={handleStep3Next} />}
      {step === 4 && (
        <Step4Payment
          initialData={formData}
          onPaymentSuccess={handlePaymentSuccess}
        />
      )}
      {step === 5 && (
        <Step5Confirmation
          initialData={formData}
          onNext={handleStep5Next}
        />
      )}
      {step === 6 && <Step6Final initialData={formData} />}
    </div>
  );
}


