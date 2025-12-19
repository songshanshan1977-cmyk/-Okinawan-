export default function Step6Final({ initialData }) {
  const { order_id } = initialData || {};

  return (
    <div className="min-h-screen bg-gray-50 flex justify-center">
      <div className="w-full max-w-xl px-6 py-16">

        {/* 顶部成功提示 */}
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold text-green-600 mb-4">
            🎉 预订成功！（押金已支付）
          </h1>
          <p className="text-gray-700">
            感谢您选择 <strong>华人 Okinawan</strong>，您的包车已成功锁定。
          </p>
        </div>

        {/* 信息卡片 */}
        <div className="bg-white rounded-2xl shadow-md p-6 space-y-4 text-center">

          <p className="text-green-700 font-medium">
            ✅ 客服将第一时间与您确认行程与司机安排
          </p>

          <p className="text-red-600 font-semibold">
            📌 请务必添加我们的售后微信
          </p>

          <p className="text-gray-800">
            添加微信时请备注订单号：
            <br />
            <span className="font-bold text-lg">{order_id}</span>
          </p>

          {/* 二维码 */}
          <div className="pt-4 flex flex-col items-center gap-2">
            <span className="text-sm text-gray-500">
              扫码添加客服微信
            </span>
            <img
              src="/w1.png.png"
              alt="客服微信二维码"
              className="rounded-lg"
              style={{
                width: "160px",
                height: "160px",
              }}
            />
          </div>
        </div>

        {/* 返回首页按钮 */}
        <div className="mt-12 flex justify-center">
          <a
            href="https://xn--okinawa-n14kh45a.com"
            className="inline-block px-10 py-4 bg-green-600 hover:bg-green-700 text-white text-lg font-semibold rounded-xl shadow"
          >
            返回首页
          </a>
        </div>

      </div>
    </div>
  );
}




