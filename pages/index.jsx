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
          content="冲绳当地华人正规包车服务 · 官方在线预约系统"
        />
      </Head>

      <div className="container">
        {/* 顶部品牌区 */}
        <header className="header">
          <h1>华人 Okinawa 包车预约系统</h1>
          <p className="tagline">Honest · Local · Reliable</p>
          <p className="subtitle">
            冲绳当地华人正规包车服务 · 官方在线预约
          </p>
        </header>

        {/* 信任说明区 */}
        <section className="trust">
          <ul>
            <li>✅ 押金仅 500 RMB，其余费用用车当日支付司机</li>
            <li>✅ 支付成功后系统自动发送订单确认邮件</li>
            <li>✅ 中文 / 日文司机可选，沟通无障碍</li>
          </ul>
        </section>

        {/* 主 CTA */}
        <section className="cta">
          <button onClick={() => router.push("/booking")}>
            立即预约包车
          </button>
        </section>

        {/* 底部兜底 */}
        <footer className="footer">
          <p>客服联系方式：微信 / WhatsApp</p>
          <p className="note">
            本系统为「华人 Okinawa」官方包车预约系统
          </p>
        </footer>
      </div>

      {/* 页面样式 */}
      <style jsx>{`
        .container {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background: #fafafa;
          padding: 24px;
          text-align: center;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
            "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
            Helvetica, Arial, sans-serif;
          color: #222;
        }

        .header h1 {
          font-size: 28px;
          margin-bottom: 8px;
        }

        .tagline {
          font-size: 14px;
          letter-spacing: 1px;
          color: #666;
          margin-bottom: 6px;
        }

        .subtitle {
          font-size: 15px;
          color: #555;
          margin-bottom: 28px;
        }

        .trust {
          background: #fff;
          border-radius: 12px;
          padding: 20px 24px;
          max-width: 520px;
          width: 100%;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.06);
          margin-bottom: 32px;
          text-align: left;
        }

        .trust ul {
          list-style: none;
          padding: 0;
          margin: 0;
        }

        .trust li {
          font-size: 15px;
          line-height: 1.8;
          margin-bottom: 8px;
        }

        .cta {
          margin-bottom: 32px;
        }

        .cta button {
          background: #2563eb;
          color: #fff;
          border: none;
          border-radius: 10px;
          padding: 14px 36px;
          font-size: 16px;
          cursor: pointer;
          box-shadow: 0 6px 18px rgba(37, 99, 235, 0.3);
        }

        .cta button:hover {
          background: #1e4ed8;
        }

        .footer {
          font-size: 13px;
          color: #777;
        }

        .note {
          margin-top: 4px;
          color: #999;
        }
      `}</style>
    </>
  );
}
