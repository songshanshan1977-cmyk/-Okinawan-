export default function Step6Final({ initialData }) {
  const { order_id, name } = initialData || {};

  return (
    <div className="max-w-2xl mx-auto py-16 text-center space-y-10">
      
      {/* 标题 */}
      <h2 className="text-3xl font-bold text-green-600">
        🎉 预订成功！（押金已支付）
      </h2>

      {/* 核心提示 */}
      <div className="text-lg text-gray-800 space-y-3">
        <p>
          感谢您{name ? `，${name}` : ""}选择
          <strong className="mx-1">华人 Okinawan</strong>。
        </p>
        <p className="font-semibold">
          ✅ 您的包车已成功锁定，请放心。
        </p>
      </div>

      {/* 重点提示：加微信 */}
      <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-6 space-y-4">
        <p className="text-red-600 font-bold text-lg">
          📌 请务必添加我们的售后微信
        </p>
        <p className="text-gray-700">
          客服将第一时间与您确认行程与司机安排。
        </p>

        {order_id && (
          <p className="text-sm text-gray-600">
            添加微信时请备注订单号：
            <strong className="ml-1">{order_id}</strong>
          </p>
        )}
      </div>

      {/* 微信二维码 */}
      <div className="space-y-3">
        <p className="font-semibold">👇 扫码添加客服微信</p>
        <img
          src="/w1.png.png"
          alt="客服微信二维码"
          className="mx-auto w-64 h-64 border rounded-lg shadow"
        />
      </div>

      {/* 返回首页 */}
      <div className="pt-6">
        <a
          href="https://xn--okinawa-n14kh45a.com"
          className="inline-block px-10 py-4 bg-black text-white text-xl rounded-lg"
        >
          返回首页
        </a>
      </div>
    </div>
  );
}


