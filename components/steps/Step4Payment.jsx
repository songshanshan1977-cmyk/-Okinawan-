// components/steps/Step4Payment.jsx

import React, { useState } from "react";
import { translations } from "../../lib/i18n/bookingTranslations";

const CREATE_ORDER_URL = "/api/create-order";
const CREATE_PAYMENT_URL = "/api/create-payment-intent"; // ✅ 统一走 Vercel

export default function Step4Payment({ initialData, bookingUiLang, onBack, onOrderIdResolved }) {
  const t = translations[bookingUiLang] || translations["zh"];

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [unavailableDates, setUnavailableDates] = useState([]);

  // ⭐ 车型显示名（显示层翻译，不影响 car_model 值）
  const carDisplayName = {
    car1: t.carName_car1,
    car2: t.carName_car2,
    car3: t.carName_car3,
  }[initialData.car_model] || initialData.car_model;

  // ⭐ 司机语言显示名（显示层翻译，driver_lang 值 "zh"/"jp" 不变）
  const driverLangDisplay =
    String(initialData.driver_lang).toLowerCase() === "zh"
      ? t.driverLangOpt_zh
      : t.driverLangOpt_jp;

  const handlePay = async () => {
    setLoading(true);
    setErrorMsg("");
    setUnavailableDates([]);

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
      // ⚠️ A3: orderData 顶层带有一次性 payment_authorization_token —— 绝不能整体
      // 打进 console（禁止 Token 进入 console/localStorage/URL query string），
      // 这里打印的是去除 Token 后的副本。
      const orderDataForLog = orderData ? { ...orderData } : orderData;
      if (orderDataForLog) delete orderDataForLog.payment_authorization_token;
      console.log("🔵 create-order 返回：", orderDataForLog);

      if (orderRes.status === 409 && orderData?.error === "paid_order_immutable") {
        // 订单已付款：不允许再修改，直接引导用户返回查看已有订单
        setErrorMsg(t.s4ErrOrderFail + orderData.error);
        setLoading(false);
        return;
      }

      if (!orderRes.ok || !orderData?.order?.order_id) {
        setErrorMsg(
          t.s4ErrOrderFail + (orderData?.error || "未返回订单号")
        );
        setLoading(false);
        return;
      }

      // ✅ 必须以数据库返回的 order_id 为准（无论是复用旧ID还是服务端新生成的ID）
      const orderId = orderData.order.order_id;

      // A3: 一次性付款授权 Token 只存在于本地变量里，绝不进入 URL query string、
      // localStorage 或 console —— 只在下面这一次 create-payment-intent 请求体
      // 里使用一次即被消费。
      const paymentToken = orderData.payment_authorization_token;

      // ⭐ 同步回父级 BookingFlow：Step4 之后的展示、重试、返回修改都必须用最新 order_id
      if (typeof onOrderIdResolved === "function") {
        onOrderIdResolved(orderId);
      }

      // ----------------------------
      // ② 创建 Stripe 押金支付
      // ----------------------------
      const payRes = await fetch(CREATE_PAYMENT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, payment_token: paymentToken }),
      });

      const payData = await payRes.json();
      console.log("🔵 create-payment-intent 返回：", payRes.status, payData);

      // ⭐ 服务端二次库存检查未通过：不创建过、不返回付款链接
      if (payRes.status === 409 && payData?.error === "inventory_unavailable") {
        setErrorMsg("NO_STOCK");
        setUnavailableDates(Array.isArray(payData?.unavailable_dates) ? payData.unavailable_dates : []);
        setLoading(false);
        return;
      }

      if (!payRes.ok || !payData?.url) {
        setErrorMsg(
          payData?.error
            ? `${t.s4ErrOrderFail}${payData.error}`
            : t.s4ErrPayFail
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
      setErrorMsg(t.s4ErrConnFail);
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8 py-8">
      <h2 className="text-2xl font-bold mb-4">{t.s4Title}</h2>

      <div className="border p-6 rounded-lg space-y-2 text-lg">
        <p>
          <strong>{t.labelOrderId}</strong>{initialData.order_id}
        </p>

        <hr />

        {initialData.itinerary && (
          <p>
            <strong>{t.labelItinerary}</strong>{initialData.itinerary}
          </p>
        )}

        <p>
          <strong>{t.labelVehicle}</strong>{carDisplayName}
        </p>

        <p>
          <strong>{t.labelDriverLang}</strong>{driverLangDisplay}
        </p>

        <p>
          <strong>{t.labelDuration}</strong>
          {initialData.duration}{t.unitHour}
        </p>
        <p>
          <strong>{t.labelPax}</strong>
          {initialData.pax}{t.unitPerson}
        </p>
        <p>
          <strong>{t.labelLuggage}</strong>
          {initialData.luggage}{t.unitItem}
        </p>

        <hr />

        <p>
          <strong>{t.labelCharterDate}</strong>
          {initialData.start_date} → {initialData.end_date}
        </p>
        <p>
          <strong>{t.labelDepartureHotel}</strong>{initialData.departure_hotel}
        </p>
        <p>
          <strong>{t.labelEndHotel}</strong>{initialData.end_hotel}
        </p>

        <hr />

        <p>
          <strong>{t.labelName}</strong>{initialData.name}
        </p>
        <p>
          <strong>{t.labelPhone}</strong>{initialData.phone}
        </p>

        {initialData.wechat && (
          <p>
            <strong>{t.labelWechat}</strong>{initialData.wechat}
          </p>
        )}

        <p>
          <strong>{t.labelEmail}</strong>{initialData.email || "—"}
        </p>
        {initialData.remark && (
          <p>
            <strong>{t.labelRemark}</strong>{initialData.remark}
          </p>
        )}

        <hr />

        <p>
          <strong>{t.labelTotalFeeAlt}</strong>¥{initialData.total_price}
        </p>

        <p className="text-blue-600 font-bold mt-4">{t.s4DepositNote}</p>

        <p className="text-sm text-gray-500">{t.s4SystemNote}</p>

        {errorMsg === "NO_STOCK" && (
          <div
            style={{
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#b91c1c",
              padding: "12px 14px",
              borderRadius: 10,
              marginTop: 12,
              fontSize: 14,
            }}
          >
            <strong>{t.s2ErrNoStockTitle}</strong>
            <div style={{ marginTop: 4 }}>
              {initialData.end_date && initialData.end_date !== initialData.start_date
                ? t.s2ErrRangeUnavailableMsg
                : t.s2ErrNoStockDesc}
            </div>
            {unavailableDates.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {t.s2UnavailableDatesLabel}
                {unavailableDates.map((d) => d.date).join("、")}
              </div>
            )}
          </div>
        )}

        {errorMsg && errorMsg !== "NO_STOCK" && (
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
          {t.s4BtnBack}
        </button>

        <button
          type="button"
          onClick={handlePay}
          disabled={loading}
          className="px-4 py-2 rounded-md bg-black text-white text-sm disabled:opacity-60"
        >
          {loading ? t.s4BtnLoading : t.s4BtnPay}
        </button>
      </div>
    </div>
  );
}
