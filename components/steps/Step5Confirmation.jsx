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
    total_price,
    name,
    phone,
    email,
    remark,
  } = initialData;

  const carNameMap = {
    car1: "经济 5 座轿车",
    car2: "豪华 7 座阿尔法",
    car3: "舒适 10 座海狮",
  };

  // ⭐ 计算尾款
  const deposit = 500;
  const balance = Math.max(total_price - deposit, 0);

  return (
    <div className="max-w-3xl mx-auto space-y-8 py-8">
      <h2 className="text-2xl font-bold">押金支付成功</h2>

      <p className="text-gray-600">
        我们已收到您的订单信息，请确认以下详情👇
      </p>

      {/* 订单编号 */}
      <div className="p-4 bg-blue-50 rounded border border-blue-200 text-lg font-semibold">
        订单编号：{order_id}
      </div>

      {/* 订单信息卡片 */}
      <div className="border p-6 rounded-lg space-y-4 text-base">
        <h3 className="text-xl font-semibold">📅 用车信息</h3>
        <p>用车日期：{start_date} → {end_date}</p>
        <p>出发酒店：{departure_hotel}</p>
        <p>结束酒店：{end_hotel}</p>

        <hr />

        <h3 className="text-xl font-semibold">🚗 车型 & 服务</h3>
        <p>车型：{carNameMap[car_model]}</p>
        <p>司机语言：{driver_lang === "zh" ? "中文司机" : "日文司机"}</p>
        <p>服务时长：{duration} 小时</p>
        <p>包车总费用：¥{total_price.toLocaleString()}</p>

        <p className="text-green-600 font-bold mt-2">
          ✔ 已支付押金：¥{deposit}
        </p>

        <p className="text-orange-600 font-bold mt-1">
          ⭐ 剩余尾款需在用车当日付清：¥{balance.toLocaleString()}
        </p>

        <hr />

        <h3 className="text-xl font-semibold">👤 客户信息</h3>
        <p>姓名：{name}</p>
        <p>电话：{phone}</p>
        <p>邮箱：{email || "未填写"}</p>
        <p>备注：{remark || "无"}</p>
      </div>

      {/* 按钮区域 */}
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
          下一步（完成 & 发确认邮件）
        </button>
      </div>
    </div>
  );
}
