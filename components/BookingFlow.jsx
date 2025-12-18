import { useState } from "react";
import Step1 from "./steps/Step1";
import Step2 from "./steps/Step2";
import Step3 from "./steps/Step3";
import Step4Payment from "./steps/Step4Payment";
import Step5Confirmation from "./steps/Step5Confirmation";
import Step6Final from "./steps/Step6Final";

// ⭐ 车型 UUID 映射（保持你原来的）
const CAR_MODEL_IDS = {
  car1: "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca",
  car2: "82cf604f-e688-49fe-aecf-69894a01f6cb",
  car3: "453df662-d350-4ab9-b811-61ffcda40d4b",
};

// ⭐ 订单号生成
function generateOrderId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = Math.floor(10000 + Math.random() * 90000);
  return `ORD-${date}-${random}`;
}

export default function BookingFlow() {
  // ⭐⭐⭐ 核心：step 在初始化时直接从 URL 读取 ⭐⭐⭐
  const [step, setStep] = useState(() => {
    if (typeof window === "undefined") return 1;
    const params = new URLSearchParams(window.location.search);
    const s = Number(params.get("step"));
    return [1, 2, 3, 4, 5, 6].includes(s) ? s : 1;
  });

  // ⭐ 表单数据（完整保留你原来的结构）
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

    // Step3
    name: "",
    phone: "",
    email: "",
    remark: "",

    // 其他
    deposit_amount: 500,
    pax: 1,
    luggage: 0,
    source: "direct",
  }));

  // ⭐ 更新数据
  const updateFormData = (patch) => {
    setFormData((prev) => {
      const next = { ...prev, ...patch };
      if (patch.car_model) {
        next.car_model_id = CAR_MODEL_IDS[patch.car_model] || "";
      }
      return next;
    });
  };

  // ===== Step 跳转 =====
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

  const handlePaymentSuccess = () => {
    setStep(5);
  };

  const handleStep5Next = () => {
    setStep(6);
  };

  const handleBack = () => {
    setStep((s) => Math.max(1, s - 1));
  };

  // ===== 渲染 =====
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


