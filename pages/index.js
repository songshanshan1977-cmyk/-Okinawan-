export default function Home() {
  return (
    <div style={{ padding: "40px", textAlign: "center" }}>
      <h1>Okinawa Booking System</h1>
      <p>网站已成功部署，现在可以进入预约页</p>

      <a
        href="/booking"
        style={{
          marginTop: "20px",
          display: "inline-block",
          padding: "12px 24px",
          background: "#0070f3",
          color: "white",
          borderRadius: "6px",
          textDecoration: "none",
          fontSize: "18px"
        }}
      >
        前往预约页面
      </a>
    </div>
  );
}
