// components/steps/Step4Payment.jsx

import React, { useState } from "react";

const CREATE_ORDER_URL = "/api/create-order"; // Vercel API（保证先写订单）
const SUPABASE_FN_URL =
  "https://xljenmxsmhmgthrlilat.supabase.co/functions/v1/create-payment-intent";

export default function Step4Payment({ initialData, onBack }) {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const handlePay = async () => {
    setLoading(true);
    setErrorMsg("");

    try {
      // ----------------------------
      // ① 先写入数据库（create-order）
      // ----------------------------
      const orderRes = await fetch(CREATE_ORDER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(initialData),
      });

      const orderData = await orderRes.json();
      console.log("🔵 create-order 返回：", orderData);

      if (!orderRes.ok) {
        setErrorMsg("订单创建失败：" + (orderData.error || "未知错误"));
        setLoading(false);
        return;
      }

      // 从 now 使用数据库订单号（稳定）
      const orderId = initialData.order_id;

      // ----------------------------
      // ② 调用 Supabase create-payment-intent
      // ----------------------------
      const payRes = await fetch(SUPABASE_FN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      });

      const payData = await payRes.json();
      console.log("🔵 create-payment-intent 返回：", payRes.status, payData);

      if (!payRes.ok || !payData?.url) {
        setErrorMsg(
          payData?.error
            ? `创建支付链接失败：${payData.error}`
            : "无法创建支付链接，请稍后再试。"
        );
        setLoading(false);
        return;
      }

      // ----------------------------
      // ③ 跳转 Stripe
      // ----------------------------
      window.location.href = payData.url;
    } catch (err) {
      console.error("🔥 支付异常：", err);
      setErrorMsg("连接支付系统失败，请稍后再试。");
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8 py-8">
      <h2 className="text-2xl font-bold mb-4">Step4：确认并支付押金</h2>

      <div className="border p-6 rounded-lg space-y-2 text-lg">
        <p><strong>订单编号：</strong> {initialData.order_id}</p>
        <p><strong>车型：</strong> {initialData.car_model}</p>
        <p><strong>司机语言：</strong> {initialData.driver_lang}</p>
        <p><strong>时长：</strong> {initialData.duration} 小时</p>
        <p><strong>日期：</strong> {initialData.start_date} → {initialData.end_date}</p>
        <p><strong>出发酒店：</strong> {initialData.departure_hotel}</p>
        <p><strong>结束酒店：</strong> {initialData.end_hotel}</p>
        <p><strong>姓名：</strong> {initialData.name}</p>
        <p><strong>电话：</strong> {initialData.phone}</p>
        <p><strong>邮箱：</strong> {initialData.email}</p>
        <p><strong>包车总费用：</strong> ¥ {initialData.total_price}</p>

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


