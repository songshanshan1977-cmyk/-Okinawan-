export default function Step6Final({ initialData }) {
  const { order_id } = initialData || {};

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center px-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-lg p-8">

        {/* 标题 */}
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-green-600 mb-2">
            🎉 预订成功！（押金已支付）
          </h1>
          <p className="text-gray-700">
            感谢您选择 <strong>华人 Okinawan</strong>，您的包车已成功锁定。
          </p>
        </div>

        {/* 说明区 */}
        <div className="space-y-3 text-gray-800 text-sm mb-6">
          <p className="flex items-start gap-2">
            <span>✅</span>
            <span>客服将第一时间与您确认行程与司机安排</span>
          </p>
          <p className="flex items-start gap-2 text-red-600 font-medium">
            <span>📌</span>
            <span>请务必添加我们的售后微信</span>
          </p>
          <p>
            添加微信时请备注订单号：
            <br />
            <span className="font-semibold text-base">{order_id}</span>
          </p>
        </div>

        {/* 二维码区 */}
        <div className="flex flex-col items-center gap-3 mb-8">
          <span className="text-sm text-gray-500">
            扫码添加客服微信
          </span>
          <img
            src="/w1.png.png"
            alt="客服微信二维码"
            style={{
              width: "220px",
              height: "220px",
            }}
            className="rounded-lg border"
          />
        </div>

        {/* 返回首页 */}
        <div className="flex justify-center">
          <a
            href="https://xn--okinawa-n14kh45a.com"
            className="px-8 py-3 bg-green-600 hover:bg-green-700 text-white text-base font-semibold rounded-lg shadow"
          >
            返回首页
          </a>
        </div>

      </div>
    </div>
  );
}





