export default function Step6Final({ initialData }) {
  return (
    <div>
      <h2 style={{ fontSize: "24px", marginBottom: "8px" }}>Step6：操作完成</h2>
      <p style={{ marginBottom: "12px" }}>
        感谢预订真诚冲绳包车服务，我们已经收到你的订单信息。
      </p>
      <p style={{ marginBottom: "12px" }}>
        订单编号：<strong>{initialData.order_id}</strong>
      </p>
      <p>稍后客服会通过 LINE / 电话 / 邮件与你确认行程细节。</p>
    </div>
  );
}
