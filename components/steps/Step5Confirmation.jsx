import { useEffect, useState } from "react";

// ✅ 与 Step3 完全一致的车型映射
const carNameMap = {
  car1: "经济 5 座轿车",
  car2: "豪华 7 座阿尔法",
  car3: "舒适 10 座海狮",
};

export default function Step5Confirmation({ onNext }) {
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get("order_id");

    if (!orderId) {
      setError("缺少订单编号");
      setLoading(false);
      return;
    }

    fetch(`/api/get-order?order_id=${orderId}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data || data.error) {
          setError(data?.error || "订单不存在");
        } else {
          setOrder(data);
        }
        setLoading(false);
      })
      .catch(() => {
        setError("加载订单失败");
        setLoading(false);
      });
  }, []);

  if (loading) return <p>正在加载订单信息...</p>;
  if (error) return <p className="text-red-600">{error}</p>;

  // ⭐⭐⭐ 核心修复点（只这一段是新增）⭐⭐⭐
  const carDisplayName =
    carNameMap[order.car_model] ||
    order.car_model || // 兜底：历史已写中文的订单
    "未选择";

  return (
    <div className="max-w-3xl mx-auto space-y-6 py-8">
      <h2 className="text-2xl font-bold">✅ 押金支付成功</h2>

      <p>您的订单已确认，我们已为您锁定车辆，请核对以下信息：</p>

      <div className="border rounded-lg p-6 space-y-3">
        <p><strong>订单编号：</strong>{order.order_id}</p>

        <hr />

        <p><strong>用车日期：</strong>{order.start_date} → {order.end_date}</p>
        <p><strong>出发酒店：</strong>{order.departure_hotel}</p>
        <p><strong>回程酒店：</strong>{order.end_hotel}</p>

        <hr />

        {/* ✅ 修复后的车型显示 */}
        <p><strong>车型：</strong>{carDisplayName}</p>

        <p><strong>司机语言：</strong>{order.driver_lang === "jp" ? "日文司机" : "中文司机"}</p>
        <p><strong>包车时长：</strong>{order.duration} 小时</p>
        <p><strong>人数：</strong>{order.pax} 人</p>
        <p><strong>行李：</strong>{order.luggage} 件</p>

        <hr />

        <p><strong>包车总费用：</strong>¥{order.total_price}</p>
        <p className="text-green-600 font-bold">✔ 已支付押金：¥500</p>
        <p className="text-orange-600">
          ⭐ 尾款需在用车当日支付给司机：¥{order.total_price - 500}
        </p>

        <hr />

        <p><strong>联系人：</strong>{order.name}</p>
        <p><strong>电话：</strong>{order.phone}</p>
        <p><strong>邮箱：</strong>{order.email || "—"}</p>
      </div>

      <button
        onClick={onNext}
        className="px-6 py-2 bg-black text-white rounded-md"
      >
        下一步
      </button>
    </div>
  );
}


