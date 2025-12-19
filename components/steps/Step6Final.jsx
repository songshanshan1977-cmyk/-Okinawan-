export default function Step6Final({ initialData }) {
  const {
    order_id,
    name,
    start_date,
    departure_hotel,
    end_hotel,
    total_price,
  } = initialData;

  const deposit = 500;
  const balance = Math.max((total_price || 0) - deposit, 0);

  return (
    <div className="max-w-3xl mx-auto py-12 space-y-8 text-center">
      {/* 标题 */}
      <h2 className="text-3xl font-bold text-green-600">
        🎉 预订成功！（押金已支付）
      </h2>

      {/* 成交确认文案 */}
      <p className="text-blue-600 text-lg font-medium">
        感谢您选择华人Okinawan，您的包车订单已确认，车辆已为您成功锁定。
      </p>

      {/* 订单信息 */}
      <div className="border rounded-lg p-6 text-left space-y-3 shadow">
        <p><strong>订单编号：</strong> {order_id}</p>

        <p>
          <strong>用车日期：</strong>{" "}
          {start_date || "已记录（客服将与您确认）"}
        </p>

        <p>
          <strong>出发酒店：</strong>{" "}
          {departure_hotel || "已记录"}
        </p>

        <p>
          <strong>回程酒店：</strong>{" "}
          {end_hotel || "已记录"}
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
      </div>

      {/* 红框重点：强制引导加微信 */}
      <div className="border-2 border-red-400 bg-red-50 rounded-lg p-5 text-red-700 text-sm space-y-2">
        <p className="font-bold text-base">📣 重要提示（请务必查看）</p>
        <p>
          为确保行程顺利进行，请您 <strong>立即添加我们的客服微信</strong>，
          并备注您的订单号：
        </p>
        <p className="font-bold text-lg">{order_id}</p>
        <p>客服将第一时间与您确认行程与司机安排。</p>
      </div>

      {/* 微信二维码 */}
      <div className="space-y-3">
        <p className="font-semibold text-gray-800">📱 客服微信二维码</p>
        <img
          src="/wechat-qrcode.png"
          alt="客服微信二维码"
          className="mx-auto w-48 h-48"
        />
        <p className="text-sm text-gray-500">
          添加时请备注订单号，方便我们快速找到您
        </p>
      </div>

      {/* 返回首页（主按钮） */}
      <div className="mt-8">
        <button
          onClick={() => {
            window.location.href = "https://xn--okinawa-n14kh45a.com";
          }}
          className="px-10 py-4 bg-black text-white text-xl rounded-lg shadow"
        >
          返回首页
        </button>
      </div>
    </div>
  );
}


