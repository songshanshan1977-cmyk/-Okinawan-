import { translations } from "../../lib/i18n/bookingTranslations";

export default function Step3({ initialData, bookingUiLang, onNext, onBack }) {
  const t = translations[bookingUiLang] || translations["zh"];

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
    itinerary,
    wechat,
  } = initialData;

  // ⭐ 车型显示名（显示层翻译，不影响 car_model 值）
  const carDisplayName = {
    car1: t.carName_car1,
    car2: t.carName_car2,
    car3: t.carName_car3,
  }[car_model] || t.notSelected;

  // ⭐ 司机语言显示名（显示层翻译，driver_lang 值 "zh"/"jp" 不变）
  const driverLangDisplay =
    String(driver_lang).toLowerCase() === "zh"
      ? t.driverLangOpt_zh
      : t.driverLangOpt_jp;

  const handleNext = () => {
    // ✅ 不改任何数据，原样进入 Step4
    onNext(initialData);
  };

  return (
    <div>
      <h2 style={{ fontSize: "24px", marginBottom: "8px" }}>
        {t.s3Title}
      </h2>

      <p style={{ color: "#6b7280", marginBottom: "16px" }}>
        {t.s3Subtitle}
      </p>

      <p style={{ color: "#4b5563", marginBottom: "16px", fontSize: "14px" }}>
        {t.labelOrderId}{order_id}
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
        <h3 style={{ fontSize: "18px", marginBottom: "8px" }}>
          {t.s3TripInfoTitle}
        </h3>
        <p>{t.labelStartDate}{start_date}</p>
        <p>{t.labelEndDate}{end_date}</p>
        <p>{t.labelDepartureHotel}{departure_hotel}</p>
        <p>{t.labelEndHotel}{end_hotel}</p>

        <hr style={{ margin: "12px 0" }} />

        <h3 style={{ fontSize: "18px", marginBottom: "8px" }}>
          {t.s3VehicleServiceTitle}
        </h3>

        {itinerary && <p>{t.labelItinerary}{itinerary}</p>}

        <p>{t.labelVehicle}{carDisplayName}</p>
        <p>{t.labelDriverLang}{driverLangDisplay}</p>
        <p>{t.labelDuration}{duration}{t.unitHour}</p>
        <p>{t.labelPax}{pax}{t.unitPerson}</p>
        <p>{t.labelLuggage}{luggage}{t.unitItem}</p>

        <p>{t.labelTotalFee}¥{total_price}</p>
        <p style={{ color: "#2563eb", fontWeight: 600, marginTop: "4px" }}>
          {t.s3DepositNote}
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
        <h3 style={{ fontSize: "18px", marginBottom: "8px" }}>
          {t.s3CustomerInfoTitle}
        </h3>

        <p>{t.labelName}{name || "-"}</p>
        <p>{t.labelPhone}{phone || "-"}</p>
        {wechat && <p>{t.labelWechat}{wechat}</p>}
        <p>{t.labelEmail}{email || "-"}</p>
        {remark && <p>{t.labelRemark}{remark}</p>}
      </div>

      <div style={{ display: "flex", gap: "8px" }}>
        <button onClick={onBack}>{t.s3BtnBack}</button>
        <button onClick={handleNext}>{t.s3BtnConfirm}</button>
      </div>
    </div>
  );
}
