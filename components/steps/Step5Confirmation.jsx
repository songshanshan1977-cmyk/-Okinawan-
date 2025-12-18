// components/steps/Step5Confirmation.jsx

import React from "react";

// ✅ 与 Step3 / Step4 完全一致的映射
const carNameMap = {
  car1: "经济 5 座轿车",
  car2: "豪华 7 座阿尔法",
  car3: "舒适 10 座海狮",
};

const driverLangMap = {
  zh: "中文司机",
  jp: "日文司机",
};

export default function Step5Confirmation({ initialData, onNext, onBack }) {
  const {
    order_id,
    start_date,
    end_date,
    departure_hotel,
    end_hotel,
    car_model,
    driver_lang,
    duration,
    pax,
    luggage,
    total_price,
    name,
    phone,
    email,
    remark,
  } = initialData;

  const deposit = 500;
  const balance = Math.max((total_price || 0) - deposit, 0);

  return (
    <div className="max-w-3xl mx-auto space-y-8 py-8">
      {/* 标题 */}
      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-green-600">
          ✅ 押金支付成功
        </h2>
        <p className="text-gray-600">
          您的订单已确认，我们已为您锁定车辆，请核对以下信息。
        </p>
      </div>

      {/* 订单编号 */}
      <div className="p-4 bg-blue-50 rounded border border-blue-200 text-lg font-semibold">
        订单编号：{order_id}
      </div>

      {/* 用车信息 */}
      <div className="border p-6 rounded-lg space-y-4 text-base">
        <h3 className="text-xl font-semibold">📅 用车信息</h3>
        <p>用车日期：{start_date} → {end_date}</p>
        <p>出发酒店：{departure_hotel}</p>
        <p>回程酒店：{end_hotel}</p>

        <hr />

        <h3 className="text-xl font-semibold">🚗 车型 & 服务</h3>
        <p>
          车型：
          {carNameMap[car_model] || car_model || "—"}
        </p>
        <p>
          司机语言：
          {driverLangMap[driver_lang] || driver_lang || "—"}
        </p>
        <p>包车时长：{duration} 小时</p>
        <p>人数：{pax} 人</p>
        <p>行李：{luggage} 件</p>

        <hr />

        <h3 className="text-xl font-semibold">💰 费用信息</h3>
        <p>包车总费用：¥{total_price || 0}</p>

        <p className="text-green-600 font-bold mt-2">
          ✔ 已支付押金：¥{deposit}
        </p>

        <p className="text-orange-600 font-bold mt-1">
          ⭐ 尾款需在用车当日支付给司机：¥{balance}
        </p>

        <div className="mt-3 text-sm text-gray-600 bg-green-50 border border-green-200 rounded p-3">
          押金支付成功后，车辆已为您锁定。如需修改订单，请提前联系客服。
        </div>

        <hr />

        <h3 className="text-xl font-semibold">👤 联系人信息</h3>
        <p>姓名：{name || "—"}</p>
        <p>电话：{phone || "—"}</p>
        <p>邮箱：{email || "—"}</p>
        <p>备注：{remark || "无"}</p>
      </div>

      {/* 按钮 */}
      <div className="flex gap-4">
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 border rounded text-gray-700"
        >
          返回
        </button>

        <button
          type="button"
          onClick={onNext}
          className="px-4 py-2 rounded bg-black text-white"
        >
          下一步
        </button>
      </div>
    </div>
  );
}

