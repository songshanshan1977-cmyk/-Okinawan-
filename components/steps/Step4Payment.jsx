// components/steps/Step4Payment.jsx

import React, { useState } from "react";

// ⭐ 直接调用 Supabase Edge Function 的地址
const SUPABASE_FN_URL =
  "https://xljenmxsmhmgthrlilat.supabase.co/functions/v1/create-payment-intent";

export default function Step4Payment({ initialData, onBack }) {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const handlePay = async () => {
    setLoading(true);
    setErrorMsg("");

    try {
      // 🔵 打到 Supabase edge function（POST）
      const res = await fetch(SUPABASE_FN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: initialData.order_id, // 必须和 orders 表里的 order_id 完全一样
        }),
      });

      const data = await res.json();
      console.log("🔵 create-payment-intent 返回：", res.status, data);

      // 后端没返回 url（比如 404 Order not found），就提示错误
      if (!res.ok || !data?.url) {
        setErrorMsg(
          data?.error
            ? `创建支付链接失败：${data.error}`
            : "无法创建支付链接，请稍后再试。"
        );
        setLoading(false);
        return;
      }

      // ✅ 跳转 Stripe Checkout 收银台
      window.location.href = data.url;
    } catch (err) {
      console.error("🔥 支付请求异常：", err);
      setErrorMsg("连接支付系统失败，请稍后重试。");
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8 py-8">
      <h2 className="text-2xl font-bold mb-4">Step4：确认并支付押金</h2>

      {/* 订单摘要 */}
      <div className="border p-6 rounded-lg space-y-2 text-lg">
        <p>
          <strong>订单编号：</strong> {initialData.order_id}
        </p>
        <p>
          <strong>车型：</strong> {initialData.car_model}
        </p>
        <p>
          <strong>司机语言：</strong> {initialData.driver_lang}
        </p>
        <p>
          <strong>时长：</strong> {initialData.duration} 小时
        </p>
        <p>
          <strong>日期：</strong> {initialData.start_date} →{" "}
          {initialData.end_date}
        </p>
        <p>
          <strong>出发酒店：</strong> {initialData.departure_hotel}
        </p>
        <p>
          <strong>结束酒店：</strong> {initialData.end_hotel}
        </p>
        <p>
          <strong>姓名：</strong> {initialData.name}
        </p>
        <p>
          <strong>电话：</strong> {initialData.phone}
        </p>
        <p>
          <strong>邮箱：</strong> {initialData.email}
        </p>
        <p>
          <strong>包车总费用：</strong> ¥ {initialData.total_price}
        </p>

        <p className="text-blue-600 font-bold mt-4">
          本次将前往 Stripe 支付押金：¥500
        </p>

        {errorMsg && (
          <p className="text-red-600 text-base mt-3 whitespace-pre-line">
            {errorMsg}
          </p>
        )}
      </div>

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 border rounded-md text-sm"
        >
          返回上一步
        </button>

        <button
          type="button"
          onClick={handlePay}
          disabled={loading}
          className="px-4 py-2 rounded-md bg-black text-white text-sm disabled:opacity-60"
        >
          {loading ? "正在创建支付链接..." : "前往 Stripe 支付押金"}
        </button>
      </div>
    </div>
  );
}

