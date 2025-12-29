import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";

// ✅ 只用于“补车型名”，不影响其他逻辑
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

export default function Step5Confirmation({ onNext }) {
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState(null);
  const [error, setError] = useState("");
  const [carName, setCarName] = useState(""); // ⭐ 新增：仅用于显示车型

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
      .then(async (data) => {
        if (!data || data.error) {
          setError(data?.error || "订单不存在");
          setLoading(false);
          return;
        }

        setOrder(data);

        // =========================
        // ⭐ 仅在车型为空时补车型名
        // =========================
        if (!data.car_model && data.car_model_id) {
          const { data: car, error: carErr } = await supabase
            .from("cars")
            .select("name_zh, name_jp")
            .eq("id", data.car_model_id)
            .single();

          if (!carErr && car) {
            setCarName(
              data.driver_lang === "JP"
                ? car.name_jp
                : car.name_zh
            );
          }
        } else {
          // 原本有值就直接用
          setCarName(data.car_model);
        }

        setLoading(false);
      })
      .catch(() => {
        setError("加载订单失败");
        setLoading(false);
      });
  }, []);

  if (loading) {
    return <p>正在加载订单信息...</p>;
  }

  if (error) {
    return <p className="text-red-600">{error}</p>;
  }

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

        {/* ✅ 修复点：车型永远有值 */}
        <p><strong>车型：</strong>{carName || "—"}</p>

        <p>
          <strong>司机语言：</strong>
          {order.driver_lang === "JP" ? "日文司机" : "中文司机"}
        </p>
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



