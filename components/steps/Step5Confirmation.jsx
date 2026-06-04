import { useEffect, useState } from "react";
import { translations } from "../../lib/i18n/bookingTranslations";

// ⭐ 车型 UUID → 翻译 key 映射（UUID 只作只读 key，不参与业务逻辑）
const UUID_TO_T_KEY = {
  "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca": "carUuid_5fdc",
  "82cf604f-e688-49fe-aecf-69894a01f6cb": "carUuid_82cf",
  "453df662-d350-4ab9-b811-61ffcda40d4b": "carUuid_453d",
};

// ⭐ 司机语言显示名（兼容数据库 ZH/JP 和前端 zh/jp）
function renderDriverLangDisplay(v, t) {
  const x = String(v || "").toUpperCase();
  if (x === "JP") return t.driverLangOpt_jp;
  if (x === "ZH") return t.driverLangOpt_zh;
  return "—";
}

export default function Step5Confirmation({ bookingUiLang, onNext }) {
  const t = translations[bookingUiLang] || translations["zh"];

  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get("order_id");

    if (!orderId) {
      setError(t.s5ErrMissing);
      setLoading(false);
      return;
    }

    fetch(`/api/get-order?order_id=${orderId}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data || data.error) {
          setError(data?.error || t.s5ErrNotFound);
        } else {
          setOrder(data);
        }
        setLoading(false);
      })
      .catch(() => {
        setError(t.s5ErrLoad);
        setLoading(false);
      });
  }, []);

  if (loading) return <p>{t.s5Loading}</p>;
  if (error) return <p className="text-red-600">{error}</p>;

  // ===== 日期展示 =====
  const isMultiDay = order.end_date && order.end_date !== order.start_date;
  const days = isMultiDay
    ? Math.floor(
        (new Date(order.end_date) - new Date(order.start_date)) /
          (1000 * 60 * 60 * 24)
      ) + 1
    : 1;
  const daysBracket = isMultiDay
    ? t.s5DaysBracket.replace("{N}", days)
    : "";
  const dateText = isMultiDay
    ? `${order.start_date} ～ ${order.end_date}${daysBracket}`
    : order.start_date;

  const balance = Math.max((order.total_price || 0) - 500, 0);

  // ⭐ 车型显示名（从翻译表查，UUID 不参与业务逻辑）
  const carTKey = UUID_TO_T_KEY[order.car_model_id];
  const carDisplayName = carTKey ? t[carTKey] : t.notSelected;

  const contactName =
    order.name || order.contact_name || order.customer_name || "—";
  const contactPhone = order.phone || "—";

  return (
    <div className="max-w-3xl mx-auto space-y-6 py-8 px-4 md:px-0">
      <h2 className="text-2xl font-bold">{t.s5SuccessTitle}</h2>
      <p>{t.s5SuccessDesc}</p>

      <div className="border rounded-lg p-6 space-y-3">
        <p>
          <strong>{t.labelOrderId}</strong>{order.order_id}
        </p>

        <hr />

        <p>
          <strong>{t.labelCharterDate}</strong>{dateText}
        </p>
        <p>
          <strong>{t.labelDepartureHotel}</strong>{order.departure_hotel || "—"}
        </p>
        <p>
          <strong>{t.labelEndHotel}</strong>{order.end_hotel || "—"}
        </p>

        <hr />

        <p>
          <strong>{t.labelVehicle}</strong>{carDisplayName}
        </p>

        {order.itinerary && (
          <p>
            <strong>{t.labelItinerary}</strong>{order.itinerary}
          </p>
        )}

        <p>
          <strong>{t.labelDriverLang}</strong>
          {renderDriverLangDisplay(order.driver_lang, t)}
        </p>
        <p>
          <strong>{t.labelDuration}</strong>
          {order.duration}{t.unitHour}
        </p>
        <p>
          <strong>{t.labelPax}</strong>
          {order.pax}{t.unitPerson}
        </p>
        <p>
          <strong>{t.labelLuggage}</strong>
          {order.luggage}{t.unitItem}
        </p>

        <hr />

        <p>
          <strong>{t.labelTotalFeeAlt}</strong>¥{order.total_price}
        </p>
        <p className="text-green-600 font-bold">{t.s5DepositPaid}</p>
        <p className="text-orange-600">
          {t.s5Balance}¥{balance}
        </p>

        <hr />

        <p>
          <strong>{t.labelContact}</strong>{contactName}
        </p>
        <p>
          <strong>{t.labelPhone}</strong>{contactPhone}
        </p>

        {order.wechat && (
          <p>
            <strong>{t.labelWechat}</strong>{order.wechat}
          </p>
        )}

        <p>
          <strong>{t.labelEmail}</strong>{order.email || "—"}
        </p>
      </div>

      <button
        onClick={onNext}
        className="w-full md:w-auto px-6 py-3 bg-black text-white rounded-md"
      >
        {t.s5BtnNext}
      </button>
    </div>
  );
}
