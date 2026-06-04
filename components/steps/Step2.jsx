import { useState, useEffect } from "react";
import { translations } from "../../lib/i18n/bookingTranslations";

// ⭐ 车型 UUID（保持不变）
const CAR_MODEL_IDS = {
  car1: "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca",
  car2: "82cf604f-e688-49fe-aecf-69894a01f6cb",
  car3: "453df662-d350-4ab9-b811-61ffcda40d4b",
};

// ⭐ 前端 zh/jp → 后端 ZH/JP（不变）
const normalizeLangForAPI = (lang) => {
  if (lang === "zh") return "ZH";
  if (lang === "jp") return "JP";
  return lang;
};

const formatDate = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const calcDays = (start, end) => {
  const s = new Date(start);
  const e = new Date(end || start);
  return Math.floor((e - s) / (1000 * 60 * 60 * 24)) + 1;
};

export default function Step2({ initialData, bookingUiLang, onNext, onBack }) {
  const t = translations[bookingUiLang] || translations["zh"];

  const [carModel, setCarModel] = useState(initialData.car_model || "");
  // ⭐ driver_lang 值保持 "zh"/"jp"，仅用于业务提交，不等于 bookingUiLang
  const [driverLang, setDriverLang] = useState(initialData.driver_lang || "zh");
  const [duration, setDuration] = useState(initialData.duration || 8);
  const [totalPrice, setTotalPrice] = useState(initialData.total_price || 0);

  const [pax, setPax] = useState(initialData.pax ?? 1);
  const [luggage, setLuggage] = useState(initialData.luggage ?? 0);

  const [name, setName] = useState(initialData.name ?? "");
  const [phone, setPhone] = useState(initialData.phone ?? "");
  const [email, setEmail] = useState(initialData.email ?? "");
  const [itinerary, setItinerary] = useState(initialData.itinerary ?? "");
  const [wechat, setWechat] = useState(initialData.wechat ?? "");
  const [remark, setRemark] = useState(initialData.remark ?? "");

  const [error, setError] = useState("");
  const [stockHint, setStockHint] = useState(null);

  const fetchDailyPrice = async (modelKey, lang, hours) => {
    if (!modelKey || !initialData.start_date) return null;

    const params = new URLSearchParams({
      car_model_id: CAR_MODEL_IDS[modelKey],
      driver_lang: normalizeLangForAPI(lang),
      duration_hours: String(hours),
      use_date: initialData.start_date,
    });

    const res = await fetch(`/api/get-car-price?${params.toString()}`);
    if (!res.ok) return null;

    const data = await res.json();
    return Number(data?.price ?? 0);
  };

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setError("");
      if (!carModel) return;

      const dailyPrice = await fetchDailyPrice(carModel, driverLang, duration);
      if (cancelled) return;

      if (dailyPrice > 0) {
        const days = calcDays(initialData.start_date, initialData.end_date);
        setTotalPrice(dailyPrice * days);
      } else {
        setTotalPrice(0);
        setError(t.s2ErrPriceFail);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [carModel, driverLang, duration, initialData.start_date, initialData.end_date]);

  const checkInventory = async () => {
    const res = await fetch("/api/check-inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: initialData.start_date,
        car_model_id: CAR_MODEL_IDS[carModel],
        driver_lang: normalizeLangForAPI(driverLang),
      }),
    });

    if (!res.ok) return { ok: false, total_stock: 0 };
    const data = await res.json();
    return {
      ok: data?.ok === true,
      total_stock: Number(data?.remaining_qty ?? 0),
    };
  };

  const handleNext = async () => {
    setError("");
    setStockHint(null);

    const today = formatDate(new Date());
    if (initialData.start_date === today) {
      setError(t.s2ErrSameDay);
      return;
    }

    if (!carModel) return setError(t.s2ErrNoModel);
    if (!name.trim()) return setError(t.s2ErrNoName);
    if (!phone.trim()) return setError(t.s2ErrNoPhone);
    if (!email.trim()) return setError(t.s2ErrNoEmail);
    if (!totalPrice || totalPrice <= 0) return setError(t.s2ErrPriceFail);

    const inv = await checkInventory();
    setStockHint(inv.total_stock);

    if (!inv.ok) {
      setError("NO_STOCK");
      return;
    }

    onNext({
      order_id: initialData.order_id,
      car_model: carModel,
      car_model_id: CAR_MODEL_IDS[carModel],
      driver_lang: driverLang,   // ⭐ 业务值保持 "zh"/"jp"
      duration,
      total_price: totalPrice,
      pax: Number(pax),
      luggage: Number(luggage),
      name: name.trim(),
      phone: phone.trim(),
      wechat: wechat ?? "",
      email: email.trim(),
      itinerary: itinerary ?? "",
      remark: remark ?? "",
    });
  };

  const box = {
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    padding: 16,
    background: "#fff",
  };

  const input = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #d1d5db",
    fontSize: 14,
  };

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: 20 }}>
      <h2 style={{ fontSize: 26, marginBottom: 20 }}>{t.s2Title}</h2>

      {/* 车型 */}
      <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
        {["car1", "car2", "car3"].map((m) => (
          <div
            key={m}
            onClick={() => setCarModel(m)}
            style={{
              flex: 1,
              padding: 16,
              borderRadius: 16,
              border: carModel === m ? "2px solid #2563eb" : "1px solid #e5e7eb",
              background: carModel === m ? "#eff6ff" : "#f9fafb",
              cursor: "pointer",
              textAlign: "center",
              fontWeight: 600,
            }}
          >
            {m === "car1" && t.carName_car1}
            {m === "car2" && t.carName_car2}
            {m === "car3" && t.carName_car3}
          </div>
        ))}
      </div>

      {/* 参数 */}
      <div style={{ ...box, marginBottom: 20 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, 1fr)",
            gap: 16,
          }}
        >
          <div>
            <label>{t.s2DriverLangLabel}</label>
            <select
              style={input}
              value={driverLang}
              onChange={(e) => setDriverLang(e.target.value)}
            >
              {/* ⭐ option value 保持 "zh"/"jp"，只改显示文字 */}
              <option value="zh">{t.driverLangOpt_zh}</option>
              <option value="jp">{t.driverLangOpt_jp}</option>
            </select>
          </div>

          <div>
            <label>{t.s2DurationLabel}</label>
            <select
              style={input}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            >
              {/* ⭐ option value 保持 8/10，只改显示文字 */}
              <option value={8}>{t.durationOpt_8}</option>
              <option value={10}>{t.durationOpt_10}</option>
            </select>
          </div>

          <div>
            <label>{t.s2PaxLabel}</label>
            <select
              style={input}
              value={pax}
              onChange={(e) => setPax(e.target.value)}
            >
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label>{t.s2LuggageLabel}</label>
            <select
              style={input}
              value={luggage}
              onChange={(e) => setLuggage(e.target.value)}
            >
              {Array.from({ length: 11 }, (_, i) => i).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* 客户信息 */}
      <div style={{ ...box, marginBottom: 20 }}>
        <strong style={{ display: "block", marginBottom: 12 }}>
          {t.s2CustomerInfoTitle}
        </strong>

        <div style={{ display: "grid", gap: 12 }}>
          <input
            style={input}
            placeholder={t.s2PlaceholderName}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            style={input}
            placeholder={t.s2PlaceholderPhone}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <input
            style={input}
            placeholder={t.s2PlaceholderWechat}
            value={wechat}
            onChange={(e) => setWechat(e.target.value)}
          />
          <div style={{ display: "grid", gap: 6 }}>
            <input
              style={input}
              placeholder={t.s2PlaceholderEmail}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <div style={{ fontSize: 12, color: "#6b7280" }}>
              {t.s2EmailHint}
            </div>
          </div>
          <input
            style={input}
            placeholder={t.s2PlaceholderItinerary}
            value={itinerary}
            onChange={(e) => setItinerary(e.target.value)}
          />
          <input
            style={input}
            placeholder={t.s2PlaceholderRemark}
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
          />
        </div>
      </div>

      {/* 总价 */}
      <div style={{ fontSize: 18, marginBottom: 8 }}>
        {t.s2CurrentTotal}<strong>¥{totalPrice}</strong>
        {typeof stockHint === "number" && (
          <span style={{ marginLeft: 12, color: "#6b7280" }}>
            {t.s2StockHint}{stockHint}）
          </span>
        )}
      </div>

      {/* 库存不足提示 */}
      {error === "NO_STOCK" && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            padding: "12px 14px",
            borderRadius: 10,
            marginBottom: 16,
            fontSize: 14,
          }}
        >
          <strong>{t.s2ErrNoStockTitle}</strong>
          <div style={{ marginTop: 4 }}>{t.s2ErrNoStockDesc}</div>
        </div>
      )}

      {error && error !== "NO_STOCK" && (
        <div style={{ color: "#dc2626", marginBottom: 12 }}>{error}</div>
      )}

      <div style={{ display: "flex", gap: 12 }}>
        <button onClick={onBack}>{t.btnBack}</button>
        <button onClick={handleNext}>{t.s2BtnNextInfo}</button>
      </div>
    </div>
  );
}
