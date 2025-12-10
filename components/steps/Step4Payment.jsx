import React, { useState } from "react";

export default function Step4Payment({ initialData, onNext, onBack }) {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const handlePay = async () => {
    setLoading(true);
    setErrorMsg("");

    try {
      // ⭐ 最关键：你给的 Supabase Edge Function URL
      const FUNCTION_URL =
        "https://xljenmxsmhmghtrlilat.supabase.co/functions/v1/create-payment-intent";

      const res = await fetch(FUNCTION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: initialData.order_id, // ⭐ 只传 orderId
        }),
      });

      const data = await res.json();
      console.log("🔵 支付返回：", data);

      if (!data?.url) {
        setErrorMsg("无法创建支付链接，请稍后重试。");
        setLoading(false);
        return;
      }

      // ⭐ 直接跳转 Stripe Checkout
      window.location.href = data.url;
    } catch (error) {
      console.error("❌ 付款错误：", error);
      setErrorMsg("连接支付系统失败，请稍后再试。");
      setLoading(false);
    }
  };

  const {
    car_model_name,
    driver_lang,
    duration,
    start_date,
    end_date,
    departure_hotel,
    end_hotel,
    name,
    phone,
    email,
    remark,
    price_total,
  } = initialData;

  return (
    <div className="max-w-3xl mx-auto space-y-8 p-6">

      <h2 className="text-2xl font-bold">Step4：确认并支付押金</h2>

      <p>
        <strong>订单编号：</strong> {initialData.order_id}
      </p>

      <div className="border rounded p-4 space-y-1">
        <p><strong>车型：</strong> {car_model_name}</p>
        <p><strong>司机语言：</strong> {driver_lang}</p>
        <p><strong>时长：</strong> {duration} 小时</p>
        <p><strong>日期：</strong> {start_date} → {end_date}</p>
        <p><strong>出发酒店：</strong> {departure_hotel}</p>
        <p><strong>结束酒店：</strong> {end_hotel}</p>
        <p><strong>姓名：</strong> {name}</p>
        <p><strong>电话：</strong> {phone}</p>
        <p><strong>邮箱：</strong> {email}</p>
        {remark && <p><strong>备注：</strong> {remark}</p>}
        <p><strong>包车总费用：</strong> ¥{price_total}</p>
        <p className="text-blue-600 font-bold">
          本次将前往 Stripe 支付押金：¥500
        </p>
      </div>

      {errorMsg && (
        <div className="text-red-600 font-semibold">{errorMsg}</div>
      )}

      <div className="flex gap-4">
        <button
          onClick={onBack}
          className="px-4 py-2 border rounded"
        >
          返回上一步
        </button>

        <button
          onClick={handlePay}
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white rounded"
        >
          {loading ? "正在跳转…" : "前往 Stripe 支付押金"}
        </button>
      </div>
    </div>
  );
}
