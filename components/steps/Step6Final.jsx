export default function Step6Final({ initialData }) {
  const { order_id } = initialData || {};

  return (
    <div className="min-h-screen flex justify-center bg-white">
      <div className="w-full max-w-3xl px-6 py-14">

        {/* 标题 */}
        <div className="text-center mb-10">
          <h2 className="text-3xl font-bold text-green-600 mb-3">
            🎉 预订成功！（押金已支付）
          </h2>
          <p className="text-gray-700 text-lg">
            感谢您选择 <strong>华人 Okinawan</strong>，您的包车已成功锁定。
          </p>
        </div>

        {/* 信息区 */}
        <div className="space-y-4 text-gray-800 text-base text-center">
          <p className="text-green-700 font-medium">
            ✅ 客服将第一时间与您确认行程与司机安排
          </p>

          <p className="text-red-600 font-semibold">
            📌 请务必添加我们的售后微信
          </p>

          <p>
            添加微信时请备注订单号：
            <br />
            <span className="font-bold text-lg">{order_id}</span>
          </p>
        </div>

        {/* 二维码（关键：独立、受控、不被撑大） */}
        <div className="mt-10 flex justify-center">
          <div className="flex flex-col items-center gap-3">
            <p className="text-sm text-gray-600">
              扫码添加客服微信
            </p>

            {/* 这里是重点 */}
            <img
              src="/w1.png.png"
              alt="客服微信二维码"
              style={{
                width: "180px",
                height: "180px",
                maxWidth: "180px",
                maxHeight: "180px",
              }}
            />
          </div>
        </div>

        {/* 返回首页 */}
        <div className="mt-14 flex justify-center">
          <a
            href="https://xn--okinawa-n14kh45a.com"
            className="px-10 py-4 bg-green-600 hover:bg-green-700 text-white text-xl font-bold rounded-xl"
          >
            返回首页
          </a>
        </div>

      </div>
    </div>
  );
}



