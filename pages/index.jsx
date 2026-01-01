// pages/index.jsx

import Head from "next/head";
import { useRouter } from "next/router";

export default function Home() {
  const router = useRouter();

  return (
    <>
      <Head>
        <title>华人 Okinawa 官方包车预约系统</title>
        <meta
          name="description"
          content="冲绳当地华人正规包车服务 · 官方在线预约系统 · 押金仅 500 RMB"
        />
      </Head>

      <main
        style={{
          minHeight: "100vh",
          background:
            "radial-gradient(1200px 600px at 50% -200px, #eef2ff 0%, #ffffff 60%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "32px",
        }}
      >
        <div
          style={{
            maxWidth: "760px",
            width: "100%",
            textAlign: "center",
          }}
        >
          {/* 顶部品牌 */}
          <div style={{ marginBottom: "28px" }}>
            <div
              style={{
                fontSize: "14px",
                letterSpacing: "2px",
                color: "#64748b",
                marginBottom: "8px",
              }}
            >
              OFFICIAL BOOKING SYSTEM
            </div>

            <h1
              style={{
                fontSize: "34px",
                fontWeight: 700,
                letterSpacing: "0.4px",
                marginBottom: "10px",
              }}
            >
              华人 Okinawa 包车预约系统
            </h1>

            <p
              style={{
                fontSize: "16px",
                color: "#475569",
              }}
            >
              冲绳当地华人正规包车服务 · 官方在线预约
            </p>
          </div>

          {/* 核心说明区 */}
          <div
            style={{
              background: "#ffffff",
              borderRadius: "18px",
              padding: "32px",
              boxShadow:
                "0 30px 60px rgba(15,23,42,0.08), inset 0 1px 0 rgba(255,255,255,0.6)",
              marginBottom: "40px",
            }}
          >
            <h2
              style={{
                fontSize: "18px",
                fontWeight: 600,
                marginBottom: "20px",
              }}
            >
              系统保障
            </h2>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr",
                rowGap: "14px",
                fontSize: "15px",
                color: "#334155",
                textAlign: "left",
              }}
            >
              <div>✔ 押金仅 <strong>500 RMB</strong>，其余费用用车当日直接支付司机</div>
              <div>✔ 支付成功后，系统自动发送 <strong>订单确认邮件</strong></div>
              <div>✔ <strong>中文 / 日文司机</strong> 可选，行程沟通无障碍</div>
            </div>
          </div>

          {/* CTA */}
          <button
            onClick={() => router.push("/booking")}
            style={{
              background:
                "linear-gradient(135deg, #1e3a8a 0%, #2563eb 100%)",
              color: "#ffffff",
              border: "none",
              borderRadius: "14px",
              padding: "18px 56px",
              fontSize: "18px",
              fontWeight: 600,
              cursor: "pointer",
              boxShadow: "0 16px 32px rgba(37,99,235,0.35)",
            }}
          >
            进入包车预约
          </button>

          {/* 底部信任兜底 */}
          <div
            style={{
              marginTop: "42px",
              fontSize: "13px",
              color: "#64748b",
              lineHeight: "1.7",
            }}
          >
            <div>客服支持：微信 / WhatsApp</div>
            <div>
              本系统为 <strong>华人 Okinawa</strong> 官方包车预约平台
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

