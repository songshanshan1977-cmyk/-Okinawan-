import { translations } from "../../lib/i18n/bookingTranslations";

export default function Step6Final({ initialData, bookingUiLang }) {
  const t = translations[bookingUiLang] || translations["zh"];
  const { order_id } = initialData || {};

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center px-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-lg p-8">

        {/* 标题 */}
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-green-600 mb-2">
            {t.s6Title}
          </h1>
          <p className="text-gray-700">{t.s6Desc}</p>
        </div>

        {/* 说明区 */}
        <div className="space-y-3 text-gray-800 text-sm mb-6">
          <p className="flex items-start gap-2">
            <span>✅</span>
            <span>{t.s6Hint1}</span>
          </p>
          <p className="flex items-start gap-2 text-red-600 font-medium">
            <span>📌</span>
            <span>{t.s6Hint2}</span>
          </p>
          <p>
            {t.s6WechatNote}
            <br />
            <span className="font-semibold text-base">{order_id}</span>
          </p>
        </div>

        {/* 二维码区 */}
        <div className="flex flex-col items-center gap-3 mb-8">
          <span className="text-sm text-gray-500">{t.s6QrLabel}</span>
          <img
            src="/w1.png.png"
            alt={t.s6QrLabel}
            style={{ width: "220px", height: "220px" }}
            className="rounded-lg border"
          />
        </div>

        {/* 返回首页 */}
        <div className="flex justify-center">
          <a
            href="https://xn--okinawa-n14kh45a.com"
            className="px-8 py-3 bg-green-600 hover:bg-green-700 text-white text-base font-semibold rounded-lg shadow"
          >
            {t.s6BtnHome}
          </a>
        </div>

      </div>
    </div>
  );
}
