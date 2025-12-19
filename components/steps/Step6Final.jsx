import { useEffect, useState } from "react";

export default function Step6Final({ initialData }) {
  const { order_id } = initialData || {};
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!order_id) return;

    fetch(`/api/get-order?order_id=${order_id}`)
      .then((res) => res.json())
      .then((data) => {
        setOrder(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [order_id]);

  if (loading) {
    return <div className="text-center py-20">订单加载中...</div>;
  }

  if (!order) {
    return <div className="text-center py-20">订单信息获取失败</div>;
  }

  const deposit = 500;
  const balance = Math.max(
    (order.total_price || 0) - deposit,
    0
  );

  return (
    <div className="max-w-3xl mx-auto py-12 space-y-8 text-center">
      <h2 className="text-3xl font-bold text-green-600">
        🎉 预订成功！（押金已支付）
      </h2>

      <p className="text-blue-600 text-lg">
        感谢您选择华人 Okinawan，您的包车订单已确认，车辆已为您成功锁定。
      </p>

      {/* 订单信息 */}
      <div className="border rounded-lg p-6 text-left space-y-3 shadow">
        <p><strong>订单编号：</strong> {order.order_id}</p>
        <p><strong>姓名：</strong> {order.name}</p>
        <p><strong>联系电话：</strong> {order.phone}</p>
        <p><strong>邮箱：</strong> {order.email}</p>

        <p><strong>用车日期：</strong> {order.start_date}</p>
        <p><strong>出发酒店：</strong> {order.departure_hotel}</p>
        <p><strong>回程酒店：</strong> {order.end_hotel}</p>

        <hr />

        <p><strong>车型：</strong> {order.car_model}</p>
        <p><strong>司机语言：</strong> {order.driver_lang}</p>
        <p><strong>用车时长：</strong> {order.duration}</p>

        <hr />

        <p>
          <strong>包车总费用：</strong>{" "}
          ¥{Number(order.total_price).toLocaleString()} RMB
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

      {/* 强引导加微信 */}
      <div className="border-2 border-red-400 bg-red-50 rounded-lg p-5 text-red-700">
        <p className="font-bold text-base mb-2">📣 重要提示（请务必查看）</p>
        <p>
          请立即添加我们的客服微信，并备注您的订单号：
        </p>
        <p className="font-bold text-lg mt-2">{order.order_id}</p>
        <p className="mt-2">客服将第一时间与您确认行程与司机安排。</p>
      </div>

      {/* 微信二维码 */}
      <div className="space-y-3">
        <p className="font-semibold text-gray-800">📱 客服微信二维码</p>
        <img
          src="/wechat-qrcode.png"
          alt="客服微信二维码"
          className="mx-auto w-56 h-56"
        />
        <p className="text-sm text-gray-500">
          添加时请备注订单号，方便我们快速找到您
        </p>
      </div>

      {/* 返回首页 */}
      <button
        onClick={() =>
          (window.location.href = "https://xn--okinawa-n14kh45a.com")
        }
        className="px-10 py-4 bg-black text-white text-xl rounded-lg shadow"
      >
        返回首页
      </button>
    </div>
  );
}


