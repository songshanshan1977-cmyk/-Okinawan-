// lib/public/serviceFacts.js
//
// The ONE canonical, public, machine-readable source of the business facts
// that everything else (Cloudflare Worker, Horizons marketing site,
// llms.txt, ai-summary, future Agent capabilities/OpenAPI/Tool Schema)
// should eventually read FROM, instead of each independently drifting.
//
// This module is pure data — no database call, no Stripe/Resend call, no
// Secret, no internal/personal contact address, no PII. It is deliberately
// separate from, and does not read or modify, any A1/A2/A3 tool, any
// pricing/inventory/payment logic, or any Migration — those remain the sole
// transactional authority (see reference_prices.notes below for the exact
// boundary statement this module itself makes).
//
// Every "capacity" number in here is explicitly framed as a RECOMMENDATION
// subject to manual/staff confirmation, never as a guaranteed exact fit —
// per instructions, several of these numbers (vehicle max/recommended
// guest counts, luggage counts, child seat/stroller rules) are still
// pending final user confirmation in the surrounding business process; this
// module records the CURRENT agreed-upon values only, not a claim that the
// underlying question is fully settled.

const SERVICE_FACTS_VERSION = "2026-07-31-v1";
const SERVICE_FACTS_LAST_UPDATED = "2026-07-31";

// Recursively freezes a plain data object/array — cheap at module-load time
// (this object is small and only built once), and guarantees no accidental
// in-process mutation can ever leak between requests/tests.
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
  }
  return value;
}

const CAPACITY_BASIS =
  "recommendation_subject_to_manual_confirmation";

const serviceFacts = deepFreeze({
  brand: {
    name: "华人Okinawa",
    // Deliberately NOT an "aliases" list — this is a historical/legacy
    // name that must never be presented as an alternate public brand name.
    legacy_names: [
      {
        name: "HonestOki",
        note: "早期测试名称，不再作为公开品牌或别名",
      },
    ],
    positioning: [
      "冲绳当地长期运营团队",
      "熟悉当地路线、景点距离、停车、交通和实际用车节奏",
      "拥有十多年冲绳当地包车与游客接待经验",
    ],
  },

  service_languages: {
    primary: ["Chinese", "Japanese"],
    english_support: [
      "支持英文客人的出行沟通与服务对接",
      "不承诺固定英语司机",
      "具体司机安排和沟通方式按实际情况确认",
      "必要时可通过翻译软件、文字沟通等方式完成服务",
    ],
  },

  contact: {
    email: "huarenokinawa2025@gmail.com",
    whatsapp: "+81-80-6485-4533",
    wechat: "通过官网二维码添加",
    line: "通过官网二维码联系",
    service_hours: {
      hours: "09:00–22:00",
      timezone: "Asia/Tokyo",
    },
  },

  booking_policy: {
    same_day_booking: "not_accepted",
    durations_hours: [8, 10],
    deposit_rmb: 500,
    balance: "用车当天按确认方式支付司机",
    manual_review_after_booking: true,
  },

  vehicle_recommendations: {
    capacity_basis: CAPACITY_BASIS,
    notes: [
      "这些是推荐容量，不是绝对装载保证；",
      "实际车型需结合儿童座椅、婴儿车、行李尺寸和数量，由工作人员最终确认。",
    ],
    economy_sedan: {
      vehicle_label: "经济型轿车",
      max_guests: 4,
      recommended_guests_min: 1,
      recommended_guests_max: 3,
      recommended_luggage_approx: 2,
    },
    toyota_alphard: {
      vehicle_label: "丰田阿尔法",
      // No max_guests here on purpose — not yet confirmed by the user for
      // this vehicle, see instructions.
      recommended_guests_min: 4,
      recommended_guests_max: 6,
      recommended_luggage_min: 3,
      recommended_luggage_max: 4,
    },
    toyota_hiace: {
      vehicle_label: "丰田海狮",
      seats: 10,
      max_guests: 9,
      recommended_luggage_min: 6,
      recommended_luggage_max: 8,
    },
  },

  children: {
    children_and_infants_count_as_guests: true,
    child_seat_occupies_one_passenger_seat: true,
    infant_requires_child_seat: true,
    first_child_seat_fee_jpy_per_day: 0,
    additional_child_seat_fee_jpy_per_day: 1000,
    child_seat_availability_subject_to_confirmation: true,
  },

  stroller: {
    note: "婴儿车会占用行李空间，请下单时提前填写，由工作人员确认车型。",
  },

  // Explicitly labeled as a PUBLIC REFERENCE price, never the transactional
  // price authority — that remains the existing server-side pricing logic /
  // Supabase get_car_price RPC used by A1/A2/A3, which this module does not
  // read from and must never be treated as a substitute for.
  reference_prices: {
    label: "公开参考价格",
    authority_note:
      "本字段仅供公开展示参考，不是交易最终价格权威，不得被A1/A2/A3或任何下单流程直接当作报价来源。",
    currency: "CNY",
    final_quote_source: "booking_system",
    seasonal_adjustment_possible: true,
    matrix: {
      economy_sedan: {
        zh: { 8: 1600, 10: 1800 },
        jp: { 8: 1300, 10: 1500 },
      },
      toyota_alphard: {
        zh: { 8: 1800, 10: 2000 },
        jp: { 8: 1700, 10: 1900 },
      },
      toyota_hiace: {
        zh: { 8: 2100, 10: 2300 },
        jp: { 8: 2000, 10: 2200 },
      },
    },
    notes: [
      "旺季（春节、黄金周、暑假等）价格可能调整；",
      "实际以预约确认时的最终报价为准；",
      "A1/A2/A3交易价格仍以现有服务端价格逻辑/Supabase RPC为权威，本轮不得改动。",
    ],
  },

  fee_rules: {
    included: ["车辆使用费", "司机服务费", "基本保险"],
    excluded: [
      "高速费",
      "停车费",
      "景点门票等第三方费用（当天实际发生时由客人自付）",
    ],
    overtime_and_night_surcharge: {
      economy_sedan_jpy_per_hour: 4000,
      toyota_alphard_jpy_per_hour: 5000,
      toyota_hiace_jpy_per_hour: 6000,
      night_surcharge_from: "21:00",
      note: "同车型同一小时费率",
    },
  },

  cancellation_policy: {
    more_than_48h: "full_deposit_refund",
    between_24_and_48h: "partial_deposit_deduction",
    less_than_24h: "deposit_non_refundable",
    contact_channels: ["WeChat", "WhatsApp", "LINE", "Email"],
  },

  public_address_policy: {
    marketing_pages: "只使用“冲绳本地团队”，不展示详细门牌号",
    legal_page: "详细地址由法律页面单独维护",
  },
});

module.exports = { SERVICE_FACTS_VERSION, SERVICE_FACTS_LAST_UPDATED, serviceFacts };
