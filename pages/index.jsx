// pages/index.jsx

import { useState, useEffect } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { translations } from "../lib/i18n/bookingTranslations";

const VALID_UI_LANGS = ["zh", "zh-TW", "ja", "en", "ko"];
const SOURCE_REGEX = /^[A-Za-z0-9_-]{1,100}$/;
const ARTICLE_CODE_REGEX = /^[A-Za-z0-9_-]{1,100}$/;

export default function Home() {
  const router = useRouter();

  // ⭐ 页面显示语言（不写入 localStorage，不改 URL）
  const [bookingUiLang, setBookingUiLang] = useState("zh");
  const [validFrom, setValidFrom] = useState(null);
  const [validArticleCode, setValidArticleCode] = useState(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const langParam = params.get("lang");
    if (VALID_UI_LANGS.includes(langParam)) {
      setBookingUiLang(langParam);
    }
    const fromParam = params.get("from") || "";
    if (SOURCE_REGEX.test(fromParam)) setValidFrom(fromParam);
    const articleCodeParam = params.get("article_code") || "";
    if (ARTICLE_CODE_REGEX.test(articleCodeParam)) setValidArticleCode(articleCodeParam);
  }, []);

  const t = translations[bookingUiLang] || translations["zh"];

  // ⭐ 语言切换按钮（只切换显示文字，不改 URL / localStorage）
  const langSwitcher = (
    <div
      style={{
        display: "flex",
        gap: "8px",
        justifyContent: "flex-end",
        flexWrap: "wrap",
        marginBottom: "16px",
        paddingBottom: "10px",
        borderBottom: "1px solid #e2e8f0",
      }}
    >
      {VALID_UI_LANGS.map((code) => {
        const label = {
          zh: t.langZh,
          "zh-TW": t.langZhTW,
          ja: t.langJa,
          en: t.langEn,
          ko: t.langKo,
        }[code];
        const isActive = bookingUiLang === code;
        return (
          <button
            key={code}
            onClick={() => setBookingUiLang(code)}
            style={{
              padding: "4px 10px",
              fontSize: "13px",
              borderRadius: "6px",
              border: isActive ? "1.5px solid #3f6df6" : "1px solid #ccc",
              background: isActive ? "#eff4ff" : "#f9f9f9",
              color: isActive ? "#3f6df6" : "#555",
              fontWeight: isActive ? 600 : 400,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      <Head>
        <title>{t.homePageTitle}</title>
        <meta
          name="description"
          content="冲绳当地华人正规包车服务 · 官方在线预约系统 · 押金仅 500 RMB"
        />

        {/* ✅ 仅新增：让该根页不参与索引（不影响用户访问） */}
        <meta name="robots" content="noindex, nofollow" />
        <meta name="googlebot" content="noindex, nofollow" />

        {/* ✅ 仅新增：把"规范入口"指向真正预约页，避免 / 抢入口 */}
        <link rel="canonical" href="https://okinawan.vercel.app/booking" />
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
          {/* 语言切换按钮 */}
          {langSwitcher}

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
              {t.homeOfficialLabel}
            </div>

            <h1
              style={{
                fontSize: "34px",
                fontWeight: 700,
                letterSpacing: "0.4px",
                marginBottom: "10px",
              }}
            >
              {t.homeTitle}
            </h1>

            <p
              style={{
                fontSize: "16px",
                color: "#475569",
              }}
            >
              {t.homeSubtitle}
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
              {t.homeGuaranteeTitle}
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
              <div>
                ✔ {t.homeG1Pre}<strong>500 RMB</strong>{t.homeG1Post}
              </div>
              <div>
                ✔ {t.homeG2Pre}<strong>{t.homeG2Bold}</strong>{t.homeG2Post}
              </div>
              <div>
                ✔ <strong>{t.homeG3Bold}</strong>{t.homeG3Post}
              </div>
            </div>
          </div>

          {/* CTA —— 根据当前语言跳转，透传归因参数 */}
          <button
            onClick={() => {
              const q = new URLSearchParams();
              q.set("lang", bookingUiLang);
              if (validFrom) q.set("from", validFrom);
              if (validArticleCode) q.set("article_code", validArticleCode);
              router.push(`/booking?${q.toString()}`);
            }}
            style={{
              background: "linear-gradient(135deg, #1e3a8a 0%, #2563eb 100%)",
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
            {t.homeCta}
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
            <div>{t.homeSupport}</div>
            <div>
              {t.homePlatformPre}
              <strong>华人 Okinawa</strong>
              {t.homePlatformPost}
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
