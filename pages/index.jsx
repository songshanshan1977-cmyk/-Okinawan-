// pages/index.jsx

import Head from "next/head";
import { useRouter } from "next/router";

export default function Home() {
  const router = useRouter();

  return (
    <>
      <Head>
        <title>华人 Okinawa 包车预约系统</title>
        <meta
          name="description"
          content="冲绳当地华人正规包车服务 · 官方在线预约 · 押金仅 500 RMB"
        />
      </Head>

      <main
        style={{
          minHeight: "100vh",
          background: "linear-gradient(180deg, #f8fafc 0%, #ffffff 60%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
        }}
      >
        <div
          style={{
            maxWidth: "720px",
            width: "100%",
            textAlign: "center",
          }}
        >
          {/* 品牌区 */}
          <h1
            style={{
              fontSize: "32px",
              fontWeight: 700,
              marginBottom: "12px",
              letterSpacing: "0.5px",
            }}
          >
            华人 Okinawa 包车预约系统
          </h1>

          <p
            style={{
              fontSize: "16px",
              color: "#555",
              marginBottom: "32px",
            }}
          >
            冲绳当地华人包车 · 官方直营在线预约
          </p>

          {/* 信任说明卡片 */}
          <div
            style={{
              background: "#fff",
              borderRadius: "16px",
              padding: "28px 24px",
              boxShadow: "0 20px 40px rgba(0,0,0,0.06)",
              marginBottom: "36px",
              textAlign: "left",
            }}
          >
            <h2
              style={{
                fontSize: "18px",
                fontWeight: 600,
                marginBottom: "16px",
                textAlign: "center",
              }}
            >
              为什么选择我们
            </h2>

            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                lineHeight: "1.9",
                fontSize: "15px",
              }}
            >
              <li>✅ 仅收 <strong>500 RMB 押金</strong>，其余费用用车当日直接支付司机</li>
              <li>✅ 支付成功后，系统自动发送 <strong>订单确认邮件</strong></li>
              <li>✅ <strong>中文 / 日文司机</strong> 可选，沟通无障碍</li>
            </ul>
          </div>

          {/* 主 CTA */}
          <button
            onClick={() => router.push("/booking")}
            style={{
              background: "linear-gradient(135deg, #2563eb, #1d4ed8)",
              color: "#fff",
              border: "none",
              borderRadius: "12px",
              padding: "16px 48px",
              fontSize: "18px",
              fontWeight: 600,
              cursor: "pointer",
              boxShadow: "0 10px 24px rgba(37,99,235,0.35)",
            }}
          >
            开始包车预约
          </button>

          {/* 底部兜底 */}
          <div
            style={{
              marginTop: "36px",
              fontSize: "13px",
              color: "#777",
              lineHeight: "1.6",
            }}
          >
            <div>客服联系方式：微信 / WhatsApp</div>
            <div style={{ marginTop: "6px" }}>
              本系统为 <strong>华人 Okinawa</strong> 官方包车预约系统
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

