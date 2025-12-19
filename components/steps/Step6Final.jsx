export default function Step6Final({ initialData }) {
  const { order_id } = initialData || {};

  return (
    <div className="min-h-screen flex justify-center items-start bg-white">
      <div className="w-full max-w-4xl px-6 py-16">
        {/* 标题区 */}
        <div className="text-center space-y-4 mb-12">
          <h2 className="text-3xl font-bold text-green-600">
            🎉 预订成功！（押金已支付）
          </h2>
          <p className="text-lg text-gray-700">
            感谢您选择 <strong>华人 Okinawan</strong>，您的包车已成功锁定。
          </p>
        </div>

        {/* 内容区：左右结构 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
          {/* 左：文字信息 */}
          <div className="space-y-4 text-gray-800 text-lg">
            <p className="text-green-700 font-semibold">
              ✅ 客服将第一时间与您确认行程与司机安排
            </p>

            <p className="text-red-600 font-semibold">
              📌 请务必添加我们的售后微信
            </p>

            <p>
              添加微信时请备注订单号：
              <br />
              <span className="font-bold text-xl">{order_id}</span>
            </p>
          </div>

          {/* 右：二维码 */}
          <div className="flex flex-col items-center">
            <p className="mb-3 font-semibold text-gray-700">
              扫码添加客服微信
            </p>
            <img
              src="/w1.png.png"
              alt="客服微信二维码"
              className="w-40 h-40"
            />
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="mt-16 text-center">
          <a
            href="https://xn--okinawa-n14kh45a.com"
            className="inline-block px-14 py-5 bg-green-600 hover:bg-green-700 text-white text-2xl font-bold rounded-xl"
          >
            返回首页
          </a>
        </div>
      </div>
    </div>
  );
}


