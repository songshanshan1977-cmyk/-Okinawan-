import { useEffect, useState } from "react";

export default function Step6Final() {
  const [orderId, setOrderId] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("order_id");
    if (id) setOrderId(id);
  }, []);

  return (
    <div className="max-w-2xl mx-auto py-16 text-center space-y-10">
      {/* 标题 */}
      <h2 className="text-3xl font-bold text-green-600">
        🎉 预订成功（押金已支付）
      </h2>

      {/* 核心提示 */}
      <p className="text-lg text-gray-800 leading-relaxed">
        感谢您选择 <strong>华人 Okinawan</strong>  
        <br />
        您的包车订单已确认，车辆已为您成功锁定。
      </p>

      {/* 订单号 */}
      {orderId && (
        <p className="text-gray-600">
          订单编号：<strong>{orderId}</strong>
        </p>
      )}

      {/* 重要提示 */}
      <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-5 text-left">
        <p className="font-semibold mb-2">📌 重要提醒（请务必查看）</p>
        <p className="text-sm leading-relaxed">
          为了确保行程顺利进行，请您
          <strong> 立即添加我们的客服微信 </strong>，
          并备注您的订单编号。
          <br />
          客服将第一时间与您确认行程细节与司机安排。
        </p>
      </div>

      {/* 微信二维码 */}
      <div className="space-y-4">
        <p className="font-medium">👇 扫码添加客服微信 👇</p>
        <img
          src="/wechat-qrcode.png"
          alt="客服微信二维码"
          className="mx-auto w-60 h-60 rounded-lg border"
        />
        <p className="text-sm text-gray-500">
          添加时请备注订单编号，方便我们快速找到您
        </p>
      </div>

      {/* 返回首页 */}
      <div className="pt-6">
        <a
          href="https://xn--okinawa-n14kh45a.com"
          className="inline-block px-10 py-4 text-xl bg-black text-white rounded-lg"
        >
          返回首页
        </a>
      </div>
    </div>
  );
}


