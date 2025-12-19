export default function Step6Final({ initialData }) {
  const {
    order_id,
    name,
    start_date,
    departure_hotel,
    end_hotel,
    total_price,
  } = initialData;

  // ⭐ 固定规则（锁死）
  const deposit = 500;
  const balance = Math.max((total_price || 0) - deposit, 0);

  return (
    <div className="max-w-3xl mx-auto py-12 space-y-8 text-center">
      {/* 标题 */}
      <h2 className="text-3xl font-bold text-green-600">
        🎉 预订成功！（押金已支付）
      </h2>

      {/* 成功提示文案（修正后） */}
      <p className="text-blue-600 text-lg font-medium">
        感谢您选择华人Okinawan，您的包车订单已确认，车辆已为您成功锁定。
      </p>

      {/* 订单信息卡片 */}
      <div className="border rounded-lg p-6 text-left space-y-3 shadow">
        <p>
          <strong>订单编号：</strong> {order_id}
        </p>
        <p>
          <strong>用车日期：</strong> {start_date}
        </p>
        <p>
          <strong>出发酒店：</strong> {departure_hotel}
        </p>
        <p>
          <strong>回程酒店：</strong> {end_hotel}
        </p>

        <hr />

        <p>
          <strong>包车总费用：</strong>{" "}
          ¥{Number(total_price || 0).toLocaleString()} RMB
        </p>

        <p className="text-blue-600 font-semibold">
          ✔ 已支付押金：¥{deposit} RMB
        </p>

        <p className="text-orange-600 font-semibold">
          ⭐ 剩余尾款：¥{balance.toLocaleString()} RMB
          <br />
          （用车当日直接支付给司机）
        </p>

        <p className="text-gray-500 text-sm mt-3">
          📧 订单确认信息已发送至您的邮箱，如未收到请检查垃圾邮箱。
        </p>
      </div>

      {/* 客服说明 + 微信二维码 */}
      <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-700">
        <p className="mb-3">
          如需修改行程或有任何问题，请直接添加我们的客服微信：
        </p>
        <img
          src="/wechat-qrcode.png"
          alt="客服微信二维码"
          className="mx-auto w-40 h-40"
        />
      </div>

      {/* 操作按钮 */}
      <div className="flex justify-center gap-4 mt-6">
        <button
          onClick={() => {
            window.location.href = "https://xn--okinawa-n14kh45a.com";
          }}
          className="px-6 py-3 bg-black text-white rounded-md text-lg"
        >
          返回首页
        </button>
      </div>
    </div>
  );
}

