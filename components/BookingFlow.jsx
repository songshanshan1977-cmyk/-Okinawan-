import { useState } from "react";
import Step1 from "./steps/Step1";
import Step2 from "./steps/Step2";
import Step3 from "./steps/Step3";
import Step4Payment from "./steps/Step4Payment";
import Step5Confirmation from "./steps/Step5Confirmation";
import Step6Final from "./steps/Step6Final";

export default function BookingFlow() {
  // ⭐⭐ 关键：step 直接从 URL 初始化 ⭐⭐
  const [step, setStep] = useState(() => {
    if (typeof window === "undefined") return 1;
    const params = new URLSearchParams(window.location.search);
    const s = Number(params.get("step"));
    return [1, 2, 3, 4, 5, 6].includes(s) ? s : 1;
  });

  const dummyData = {
    order_id: "TEST-ORDER",
    start_date: "2025-01-01",
    end_date: "2025-01-01",
    departure_hotel: "Test Hotel",
    end_hotel: "Test Hotel",
    car_model: "car1",
    driver_lang: "zh",
    duration: 8,
    total_price: 10000,
    name: "测试用户",
    phone: "000000",
    email: "test@test.com",
    remark: "",
    pax: 2,
    luggage: 2,
  };

  return (
    <div style={{ padding: 24 }}>
      {step === 1 && <Step1 initialData={dummyData} onNext={() => setStep(2)} />}
      {step === 2 && <Step2 initialData={dummyData} onNext={() => setStep(3)} />}
      {step === 3 && <Step3 initialData={dummyData} onNext={() => setStep(4)} />}
      {step === 4 && (
        <Step4Payment
          initialData={dummyData}
          onPaymentSuccess={() => setStep(5)}
        />
      )}
      {step === 5 && (
        <Step5Confirmation
          initialData={dummyData}
          onNext={() => setStep(6)}
        />
      )}
      {step === 6 && <Step6Final initialData={dummyData} />}
    </div>
  );
}

