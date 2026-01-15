// components/steps/Step4Payment.jsx

import React, { useState } from "react";

const CREATE_ORDER_URL = "/api/create-order";
const CREATE_PAYMENT_URL = "/api/create-payment-intent"; // ✅ 统一走 Vercel

// ✅ 与 Step3 保持一致的展示映射
const carNameMap = {
  car1: "经济 5 座轿车",
  car2: "豪华 7 座阿尔法",
  car3: "舒适 10 座海狮",
};

const driverLangMap = {
  zh: "中文司机",
  jp: "日文司机",
};

export default function Step4Payment({ initialData, onBack }) {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const handlePay = async () => {
    setLoading(true);
    setErrorMsg("");

    try {
      // ----------------------------
      // ① 写入 orders（Vercel API）
      // ----------------------------
      const orderRes = await fetch(CREATE_ORDER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(initialData),
      });

      const orderData = await orderRes.json();
      console.log("🔵 create-order 返回：", orderData);

      if (!orderRes.ok || !orderData?.order?.order_id) {
        setErrorMsg("订单创建失败：" + (orderData?.error || "未返回订单号"));
        setLoading(false);
        return;
      }

      // ✅ 必须以数据库返回的 order_id 为准
      const orderId = orderData.order.order_id;

      // ----------------------------
      // ② 创建 Stripe 押金支付
      // ----------------------------
      const payRes = await fetch(CREATE_PAYMENT_URL, {
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
        <p>
          <strong>订单编号：</strong> {initialData.order_id}
        </p>

        <hr />

        {/* ✅ 只新增：行程（可选），放在车型上面 */}
        {initialData.itinerary && (
          <p>
            <strong>行程：</strong>
            {initialData.itinerary}
          </p>
        )}

        {/* ✅ 车型 & 司机语言：统一“人话” */}
        <p>
          <strong>车型：</strong>
          {carNameMap[initialData.car_model] || initialData.car_model}
        </p>

        <p>
          <strong>司机语言：</strong>
          {driverLangMap[initialData.driver_lang] || initialData.driver_lang}
        </p>

        <p>
          <strong>包车时长：</strong> {initialData.duration} 小时
        </p>
        <p>
          <strong>人数：</strong> {initialData.pax} 人
        </p>
        <p>
          <strong>行李：</strong> {initialData.luggage} 件
        </p>

        <hr />

        <p>
          <strong>用车日期：</strong>
          {initialData.start_date} → {initialData.end_date}
        </p>
        <p>
          <strong>出发酒店：</strong> {initialData.departure_hotel}
        </p>
        <p>
          <strong>结束酒店：</strong> {initialData.end_hotel}
        </p>

        <hr />

        <p>
          <strong>姓名：</strong> {initialData.name}
        </p>
        <p>
          <strong>电话：</strong> {initialData.phone}
        </p>
        <p>
          <strong>邮箱：</strong> {initialData.email || "—"}
        </p>
        {initialData.remark && (
          <p>
            <strong>备注：</strong> {initialData.remark}
          </p>
        )}

        <hr />

        <p>
          <strong>包车总费用：</strong>¥{initialData.total_price}
        </p>

        <p className="text-blue-600 font-bold mt-4">
          本次将前往 Stripe 支付押金：¥500
        </p>

        <p className="text-sm text-gray-500">
          ※ 支付成功后系统将自动扣减库存并确认订单
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


