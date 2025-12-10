import { useState } from "react";
import Step1 from "./steps/Step1";
import Step2 from "./steps/Step2";
import Step3 from "./steps/Step3";
import Step4Payment from "./steps/Step4Payment";
import Step5Confirmation from "./steps/Step5Confirmation";
import Step6Final from "./steps/Step6Final";

// ⭐ Supabase 车型表 UUID 映射（保持和旧仓库一致）
const CAR_MODEL_IDS = {
  car1: "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca", // 经济型 Economy
  car2: "82cf604f-e688-49fe-aecf-69894a01f6cb", // 丰田阿尔法 Alphard
  car3: "453df662-d350-4ab9-b811-61ffcda40d4b", // 海狮 Hiace
};

// ⭐ 订单编号生成（你之前选的方案 B）
function generateOrderId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // 20251210
  const rand = Math.floor(100000 + Math.random() * 900000); // 6 位随机数
  return `ORD-${date}-${rand}`;
}

export default function BookingFlow() {
  const [step, setStep] = useState(1);

  // ⭐ 所有步骤共用的表单数据（字段尽量对齐旧仓库）
  const [formData, setFormData] = useState(() => ({
    order_id: generateOrderId(),

    // Step1
    start_date: "",
    end_date: "",
    departure_hotel: "",
    end_hotel: "",

    // Step2
    car_model: "", // car1 / car2 / car3
    car_model_id: "",
    driver_lang: "zh", // zh / jp
    duration: 8, // 小时
    total_price: 0, // 总价（日元）

    // Step3
    name: "",
    phone: "",
    email: "",
    remark: "",
  }));

  // ⭐ 更新数据时，自动带上 car_model_id
  const updateFormData = (patch) => {
    setFormData((prev) => {
      const next = { ...prev, ...patch };

      if (patch.car_model) {
        next.car_model_id = CAR_MODEL_IDS[patch.car_model] || "";
      }

      return next;
    });
  };

  // --- 每一步的 onNext / onBack ---

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

  // Step4 支付成功后（或者 Stripe 返回成功页面后），再手动切第 5 步
  const handlePaymentSuccess = () => {
    setStep(5);
  };

  const handleStep5Next = () => {
    setStep(6);
  };

  const handleBack = () => {
    setStep((s) => Math.max(1, s - 1));
  };

  return (
    <div style={{ padding: "24px", maxWidth: "960px", margin: "0 auto" }}>
      {step === 1 && (
        <Step1 initialData={formData} onNext={handleStep1Next} />
      )}

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
          // 支付成功后你可以在 Stripe success_url 里跳回 /booking?step=5
          // 现在先保留一个回调，后面可以在需要的时候手动触发
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
