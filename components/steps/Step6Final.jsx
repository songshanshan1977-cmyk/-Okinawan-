export default function Step6Final({ initialData }) {
  const { order_id } = initialData || {};

  return (
    <div className="max-w-2xl mx-auto py-16 text-center space-y-10">
      {/* 标题 */}
      <h2 className="text-3xl font-bold text-green-600">
        🎉 预订成功！（押金已支付）
      </h2>

      {/* 核心确认文案 */}
      <div className="space-y-3 text-lg text-gray-800">
        <p>感谢您选择 <strong>华人 Okinawan</strong>。</p>

        <p className="flex items-center justify-center gap-2 text-green-700 font-semibold">
          ✅ 您的包车已成功锁定，请放心。
        </p>

        <p className="flex items-center justify-center gap-2 text-red-600 font-semibold">
          📌 请务必添加我们的售后微信
        </p>

        <p className="text-gray-700">
          客服将第一时间与您确认行程与司机安排。
        </p>

        <p className="text-gray-900">
          添加微信时请备注订单号：
          <br />
          <span className="font-bold text-lg">{order_id}</span>
        </p>
      </div>

      {/* 微信二维码 */}
      <div className="space-y-4">
        <p className="text-lg font-semibold">👇 扫码添加客服微信</p>

        <img
          src="/w1.png.png"
          alt="客服微信二维码"
          className="mx-auto w-40 h-40 rounded-lg shadow"
        />
      </div>

      {/* 返回首页 */}
      <div className="pt-8">
        <a
          href="https://xn--okinawa-n14kh45a.com"
          className="inline-block px-12 py-5 bg-green-600 hover:bg-green-700 text-white text-2xl font-bold rounded-xl shadow-lg"
        >
          返回首页
        </a>
      </div>
    </div>
  );
}



