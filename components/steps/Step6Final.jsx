export default function Step6Final({ initialData }) {
  const {
    order_id,
    name,
    start_date,
    departure_hotel,
    total_price,
  } = initialData;

  const deposit = 500;
  const balance = Math.max(total_price - deposit, 0);

  return (
    <div className="max-w-3xl mx-auto py-10 space-y-6 text-center">
      <h2 className="text-3xl font-bold text-green-600">
        🎉 预订成功！（押金已支付）
      </h2>

      <p className="text-gray-700 text-lg">
        感谢您，{name}！您的包车订单已确认，我们会尽快与您联系。
      </p>

      {/* 订单卡片 */}
      <div className="border rounded-lg p-6 text-left space-y-3 shadow">
        <p><strong>订单编号：</strong> {order_id}</p>
        <p><strong>用车日期：</strong> {start_date}</p>
        <p><strong>出发酒店：</strong> {departure_hotel}</p>
        <p><strong>总费用：</strong> ¥{total_price}</p>

        <p className="text-blue-600 font-semibold">
          ✔ 已支付押金：¥{deposit}
        </p>

        <p className="text-orange-600 font-semibold">
          ⭐ 剩余尾款：¥{balance}（用车当日付款）
        </p>

        <p className="text-gray-500 text-sm mt-2">
          详细确认邮件已发送到您的邮箱，请注意查收。
        </p>
      </div>

      {/* 按钮 */}
      <div className="flex justify-center gap-4 mt-6">
        <a
          href="/"
          className="px-6 py-3 bg-black text-white rounded-md text-lg"
        >
          返回首页
        </a>

        <a
          href={`https://wa.me/819021716363?text=我要确认订单%20${order_id}`}
          target="_blank"
          className="px-6 py-3 border border-green-600 text-green-600 rounded-md text-lg"
        >
          立即联系客服
        </a>
      </div>
    </div>
  );
}
