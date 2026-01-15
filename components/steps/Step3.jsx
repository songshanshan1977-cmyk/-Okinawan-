const carNameMap = {
  car1: "经济 5 座轿车",
  car2: "豪华 7 座阿尔法",
  car3: "舒适 10 座海狮",
};

export default function Step3({ initialData, onNext, onBack }) {
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
    pax,
    luggage,
    name,
    phone,
    email,
    remark,

    // ✅ 只新增：行程（可选）
    itinerary,
  } = initialData;

  const handleNext = () => {
    // ✅ 不改任何数据，原样进入 Step4
    onNext(initialData);
  };

  return (
    <div>
      <h2 style={{ fontSize: "24px", marginBottom: "8px" }}>
        Step3：订单确认
      </h2>

      <p style={{ color: "#6b7280", marginBottom: "16px" }}>
        请确认以下信息无误后再进行支付。
      </p>

      <p style={{ color: "#4b5563", marginBottom: "16px", fontSize: "14px" }}>
        订单编号：{order_id}
      </p>

      {/* 用车信息 */}
      <div
        style={{
          background: "#fff",
          borderRadius: "12px",
          padding: "16px",
          boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
          marginBottom: "16px",
        }}
      >
        <h3 style={{ fontSize: "18px", marginBottom: "8px" }}>📅 用车信息</h3>
        <p>开始日期：{start_date}</p>
        <p>结束日期：{end_date}</p>
        <p>出发酒店：{departure_hotel}</p>
        <p>结束酒店：{end_hotel}</p>

        <hr style={{ margin: "12px 0" }} />

        <h3 style={{ fontSize: "18px", marginBottom: "8px" }}>🚗 车型 & 服务</h3>

        {/* ✅ 只新增：行程（可选）放在车型上面 */}
        {itinerary && <p>行程：{itinerary}</p>}

        <p>车型：{carNameMap[car_model] || "未选择"}</p>
        <p>司机语言：{driver_lang === "zh" ? "中文司机" : "日文司机"}</p>
        <p>包车时长：{duration} 小时</p>
        <p>人数：{pax} 人</p>
        <p>行李：{luggage} 件</p>

        <p>包车费用：¥{total_price}</p>
        <p style={{ color: "#2563eb", fontWeight: 600, marginTop: "4px" }}>
          需支付押金：¥500（固定）
        </p>
      </div>

      {/* 客户信息（只读） */}
      <div
        style={{
          background: "#fff",
          borderRadius: "12px",
          padding: "16px",
          boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
          marginBottom: "16px",
        }}
      >
        <h3 style={{ fontSize: "18px", marginBottom: "8px" }}>👤 客户信息</h3>

        <p>姓名：{name || "-"}</p>
        <p>电话：{phone || "-"}</p>
        <p>邮箱：{email || "-"}</p>
        {remark && <p>备注：{remark}</p>}
      </div>

      <div style={{ display: "flex", gap: "8px" }}>
        <button onClick={onBack}>返回修改</button>
        <button onClick={handleNext}>确认并前往支付</button>
      </div>
    </div>
  );
}

