export default function Step6Final() {
  return (
    <div className="max-w-3xl mx-auto py-16 px-6 text-center space-y-10">
      {/* 成功提示 */}
      <h2 className="text-3xl md:text-4xl font-bold text-green-600">
        🎉 预订成功，车辆已为您锁定
      </h2>

      <p className="text-lg text-gray-700">
        感谢您选择 <strong>华人 Okinawa 包车服务</strong><br />
        为了方便后续联系与行程确认，请您务必添加我们的售后微信。
      </p>

      {/* 微信二维码 */}
      <div className="flex flex-col items-center space-y-4">
        <img
          src="/w1.png"
          alt="客服微信二维码"
          className="w-64 h-64 border rounded-lg shadow"
        />
        <p className="text-sm text-gray-600">
          📱 微信扫码添加客服（用于订单确认 / 行程沟通）
        </p>
      </div>

      {/* 返回首页 */}
      <div className="pt-8">
        <a
          href="https://xn--okinawa-n14kh45a.com"
          className="inline-block text-xl px-10 py-4 bg-black text-white rounded-lg"
        >
          返回首页
        </a>
      </div>
    </div>
  );
}


