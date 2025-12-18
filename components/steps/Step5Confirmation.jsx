export default function Step5Confirmation({ initialData, onNext, onBack }) {
  const {
    order_id,
    start_date,
    end_date,
    departure_hotel,
    end_hotel,
    car_model,
    driver_lang,
    duration,
    total_price,
    name,
    phone,
    email,
    pax,
    luggage,
  } = initialData;

  const deposit = 500;
  const balance = Math.max(total_price - deposit, 0);

  const carNameMap = {
    car1: "经济 5 座轿车",
    car2: "豪华 7 座阿尔法",
    car3: "舒适 10 座海狮",
  };

  return (
    <div style={{ padding: 40, maxWidth: 800, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 16 }}>✅ 押金支付成功</h1>

      <p style={{ marginBottom: 24 }}>
        您的订单已确认，我们已为您锁定车辆，请核对以下信息：
      </p>

      <div style={{ background: "#f9fafb", padding: 20, borderRadius: 8 }}>
        <p><strong>订单编号：</strong>{order_id}</p>

        <hr />

        <h3>📅 用车信息</h3>
        <p>用车日期：{start_date} ～ {end_date}</p>
        <p>出发酒店：{departure_hotel}</p>
        <p>回程酒店：{end_hotel}</p>

        <hr />

        <h3>🚗 车型 & 服务</h3>
        <p>车型：{carNameMap[car_model] || "—"}</p>
        <p>司机语言：{driver_lang === "zh" ? "中文司机" : "日文司机"}</p>
        <p>包车时长：{duration} 小时</p>
        <p>人数：{pax} 人　行李：{luggage} 件</p>

        <hr />

        <h3>💰 费用信息</h3>
        <p>包车总费用：¥{total_price}</p>
        <p style={{ color: "green", fontWeight: "bold" }}>
          已支付押金：¥{deposit}
        </p>
        <p style={{ color: "#d97706", fontWeight: "bold" }}>
          尾款需在用车当日支付给司机：¥{balance}
        </p>

        <hr />

        <h3>👤 联系人信息</h3>
        <p>姓名：{name || "—"}</p>
        <p>电话：{phone || "—"}</p>
        <p>邮箱：{email || "—"}</p>
      </div>

      <div style={{ marginTop: 32 }}>
        <button onClick={onBack}>返回</button>
        <button onClick={onNext} style={{ marginLeft: 16 }}>
          前往感谢页
        </button>
      </div>
    </div>
  );
}
