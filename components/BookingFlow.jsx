import { useState, useEffect } from "react";
import Step1 from "./steps/Step1";
import Step2 from "./steps/Step2";
import Step3 from "./steps/Step3";
import Step4Payment from "./steps/Step4Payment";
import Step5Confirmation from "./steps/Step5Confirmation";
import Step6Final from "./steps/Step6Final";

// ⭐ 车型 UUID 映射（保持不变）
const CAR_MODEL_IDS = {
  car1: "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca",
  car2: "82cf604f-e688-49fe-aecf-69894a01f6cb",
  car3: "453df662-d350-4ab9-b811-61ffcda40d4b",
};

// ⭐ 订单号生成（仅用于“正常流程”）
function generateOrderId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = Math.floor(10000 + Math.random() * 90000);
  return `ORD-${date}-${random}`;
}

export default function BookingFlow() {
  // ✅ step 默认 1
  const [step, setStep] = useState(1);

  // ⭐ 表单数据（完整结构不动）
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

  // =====================================================
  // ⭐⭐ 核心补丁：Stripe 回来时加载 Step + 订单数据 ⭐⭐
  // =====================================================
  useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    const stepFromUrl = Number(params.get("step"));
    const orderIdFromUrl = params.get("order_id");

    // ① 先处理 step
    if ([1, 2, 3, 4, 5, 6].includes(stepFromUrl)) {
      setStep(stepFromUrl);
    }

    // ② 如果是 Stripe 回来的 Step5，用 order_id 拉订单
    if (stepFromUrl === 5 && orderIdFromUrl) {
      fetch(`/api/get-order?order_id=${orderIdFromUrl}`)
        .then((res) => res.json())
        .then((data) => {
          if (data?.order) {
            setFormData((prev) => ({
              ...prev,
              ...data.order,
            }));
          }
        })
        .catch((err) => {
          console.error("❌ 加载订单失败：", err);
        });
    }
  }, []);

  // ⭐ 更新数据（保持你原来的逻辑）
  const updateFormData = (patch) => {
    setFormData((prev) => {
      const next = { ...prev, ...patch };
      if (patch.car_model) {
        next.car_model_id = CAR_MODEL_IDS[patch.car_model] || "";
      }
      return next;
    });
  };

  // ================= 渲染 =================
  return (
    <div style={{ padding: "24px", maxWidth: "960px", margin: "0 auto" }}>
      {step === 1 && (
        <Step1
          initialData={formData}
          onNext={(v) => {
            updateFormData(v);
            setStep(2);
          }}
        />
      )}

      {step === 2 && (
        <Step2
          initialData={formData}
          onNext={(v) => {
            updateFormData(v);
            setStep(3);
          }}
          onBack={() => setStep(1)}
        />
      )}

      {step === 3 && (
        <Step3
          initialData={formData}
          onNext={(v) => {
            updateFormData(v);
            setStep(4);
          }}
          onBack={() => setStep(2)}
        />
      )}

      {step === 4 && (
        <Step4Payment
          initialData={formData}
          onBack={() => setStep(3)}
          onPaymentSuccess={() => setStep(5)}
        />
      )}

      {step === 5 && (
        <Step5Confirmation
          initialData={formData}
          onNext={() => setStep(6)}
          onBack={() => setStep(4)}
        />
      )}

      {step === 6 && <Step6Final initialData={formData} />}
    </div>
  );
}


