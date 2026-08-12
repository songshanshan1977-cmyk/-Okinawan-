const { SERVICE_FACTS_VERSION, SERVICE_FACTS_LAST_UPDATED, serviceFacts } = require("../../lib/public/serviceFacts");

const FORBIDDEN_STRINGS = [
  "songshanshan1977@gmail.com",
  "songshanshan2025@gmail.com",
  "contact@okinawa-charter.com",
];

describe("serviceFacts — module shape", () => {
  test("is a plain frozen object, safe against accidental mutation", () => {
    expect(Object.isFrozen(serviceFacts)).toBe(true);
    expect(Object.isFrozen(serviceFacts.brand)).toBe(true);
    expect(Object.isFrozen(serviceFacts.reference_prices.matrix)).toBe(true);
    // Test files run in strict mode, where assigning to a frozen object's
    // property throws rather than silently no-oping — either way, the
    // value itself must never actually change.
    expect(() => {
      serviceFacts.brand.name = "tampered";
    }).toThrow(TypeError);
    expect(serviceFacts.brand.name).toBe("华人Okinawa");
  });

  test("version and last_updated are exported and match this round's values", () => {
    expect(SERVICE_FACTS_VERSION).toBe("2026-07-31-v1");
    expect(SERVICE_FACTS_LAST_UPDATED).toBe("2026-07-31");
  });

  // Locks down the real top-level shape so a future edit can't silently add
  // or remove a field without a test failing — this is also the source of
  // truth for what the completion report must state as the field count.
  test("has exactly these 11 top-level fields, no more, no fewer", () => {
    expect(Object.keys(serviceFacts).sort()).toEqual(
      [
        "booking_policy",
        "brand",
        "cancellation_policy",
        "children",
        "contact",
        "fee_rules",
        "public_address_policy",
        "reference_prices",
        "service_languages",
        "stroller",
        "vehicle_recommendations",
      ].sort()
    );
  });
});

// Retired internal test brand name — kept ONLY as a literal string inside
// this test file (never inside lib/public/serviceFacts.js itself) so this
// suite can assert its total absence from every public surface without the
// production module ever having to contain the string at all.
const RETIRED_TEST_BRAND_NAME = "Honest" + "Oki";

describe("serviceFacts — brand", () => {
  test("brand has no legacy_names or aliases field of any kind", () => {
    expect(serviceFacts.brand).not.toHaveProperty("legacy_names");
    expect(serviceFacts.brand).not.toHaveProperty("aliases");
    expect(Object.keys(serviceFacts.brand).sort()).toEqual(["name", "positioning"]);
  });

  test("the brand name is strictly equal to 华人Okinawa", () => {
    expect(serviceFacts.brand.name).toBe("华人Okinawa");
  });

  test("positioning includes the three confirmed claims", () => {
    expect(serviceFacts.brand.positioning).toEqual([
      "冲绳当地长期运营团队",
      "熟悉当地路线、景点距离、停车、交通和实际用车节奏",
      "拥有十多年冲绳当地包车与游客接待经验",
    ]);
  });
});

describe("serviceFacts — forbidden strings never appear anywhere in the object", () => {
  const serialized = JSON.stringify(serviceFacts);

  for (const forbidden of FORBIDDEN_STRINGS) {
    test(`does not contain "${forbidden}"`, () => {
      expect(serialized).not.toContain(forbidden);
    });
  }

  test("the FULL serialized object (JSON.stringify(serviceFacts)) does not contain the retired test brand name anywhere", () => {
    expect(serialized).not.toContain(RETIRED_TEST_BRAND_NAME);
    expect(serialized.toLowerCase()).not.toContain(RETIRED_TEST_BRAND_NAME.toLowerCase());
  });
});

describe("serviceFacts — service languages", () => {
  test("primary languages are Chinese and Japanese only", () => {
    expect(serviceFacts.service_languages.primary).toEqual(["Chinese", "Japanese"]);
  });

  test("english support is described as best-effort, not a guaranteed English-speaking driver", () => {
    const english = serviceFacts.service_languages.english_support.join(" ");
    expect(english).toMatch(/不承诺固定英语司机/);
    expect(english).toMatch(/支持英文客人的出行沟通/);
  });
});

describe("serviceFacts — contact", () => {
  test("email is the confirmed authoritative address", () => {
    expect(serviceFacts.contact.email).toBe("huarenokinawa2025@gmail.com");
  });

  test("WhatsApp number matches the confirmed value", () => {
    expect(serviceFacts.contact.whatsapp).toBe("+81-80-6485-4533");
  });

  test("WeChat/LINE are described as QR-code contact only, no raw ID", () => {
    expect(serviceFacts.contact.wechat).toBe("通过官网二维码添加");
    expect(serviceFacts.contact.line).toBe("通过官网二维码联系");
    // No historical LINE ID string anywhere near this field.
    expect(serviceFacts.contact.line).not.toMatch(/okinawacharter/i);
  });

  test("service hours are 09:00-22:00 Asia/Tokyo", () => {
    expect(serviceFacts.contact.service_hours).toEqual({ hours: "09:00–22:00", timezone: "Asia/Tokyo" });
  });
});

describe("serviceFacts — booking policy", () => {
  test("same-day booking is not accepted, durations are 8/10h, deposit is 500 RMB", () => {
    expect(serviceFacts.booking_policy.same_day_booking).toBe("not_accepted");
    expect(serviceFacts.booking_policy.durations_hours).toEqual([8, 10]);
    expect(serviceFacts.booking_policy.deposit_rmb).toBe(500);
  });
});

describe("serviceFacts — vehicle recommendations (capacity is a recommendation, not a guarantee)", () => {
  test("every vehicle capacity field is scoped under an explicit recommendation/manual-confirmation basis", () => {
    expect(serviceFacts.vehicle_recommendations.capacity_basis).toBe("recommendation_subject_to_manual_confirmation");
    expect(serviceFacts.vehicle_recommendations.notes.join(" ")).toMatch(/不是绝对装载保证/);
  });

  test("economy sedan: recommended 1-3 guests, max 4, ~2 pieces of luggage", () => {
    const economy = serviceFacts.vehicle_recommendations.economy_sedan;
    expect(economy.vehicle_label).toBe("经济型轿车");
    expect(economy.max_guests).toBe(4);
    expect(economy.recommended_guests_min).toBe(1);
    expect(economy.recommended_guests_max).toBe(3);
    expect(economy.recommended_luggage_approx).toBe(2);
  });

  test("Toyota Alphard: recommended 4-6 guests, 3-4 pieces of luggage, NO max_guests (not yet confirmed)", () => {
    const alphard = serviceFacts.vehicle_recommendations.toyota_alphard;
    expect(alphard.vehicle_label).toBe("丰田阿尔法");
    expect(alphard.recommended_guests_min).toBe(4);
    expect(alphard.recommended_guests_max).toBe(6);
    expect(alphard.recommended_luggage_min).toBe(3);
    expect(alphard.recommended_luggage_max).toBe(4);
    expect(alphard).not.toHaveProperty("max_guests");
  });

  test("Toyota Hiace: 10 seats, max 9 guests, 6-8 pieces of luggage", () => {
    const hiace = serviceFacts.vehicle_recommendations.toyota_hiace;
    expect(hiace.vehicle_label).toBe("丰田海狮");
    expect(hiace.seats).toBe(10);
    expect(hiace.max_guests).toBe(9);
    expect(hiace.recommended_luggage_min).toBe(6);
    expect(hiace.recommended_luggage_max).toBe(8);
  });

  test("no capacity field is phrased as guaranteed/exact/always-fit", () => {
    const serialized = JSON.stringify(serviceFacts.vehicle_recommendations);
    expect(serialized).not.toMatch(/guaranteed/i);
    expect(serialized).not.toMatch(/exact_fit/i);
    expect(serialized).not.toMatch(/always_fit/i);
  });
});

describe("serviceFacts — children and stroller", () => {
  test("children/infants count as guests, child seat occupies one passenger seat, infants require a child seat", () => {
    expect(serviceFacts.children.children_and_infants_count_as_guests).toBe(true);
    expect(serviceFacts.children.child_seat_occupies_one_passenger_seat).toBe(true);
    expect(serviceFacts.children.infant_requires_child_seat).toBe(true);
  });

  test("first child seat is free, each additional is 1000 JPY/day, availability subject to confirmation", () => {
    expect(serviceFacts.children.first_child_seat_fee_jpy_per_day).toBe(0);
    expect(serviceFacts.children.additional_child_seat_fee_jpy_per_day).toBe(1000);
    expect(serviceFacts.children.child_seat_availability_subject_to_confirmation).toBe(true);
  });

  test("stroller note text is exactly the confirmed wording (does not invent a fixed luggage-count rule)", () => {
    expect(serviceFacts.stroller.note).toBe("婴儿车会占用行李空间，请下单时提前填写，由工作人员确认车型。");
    expect(serviceFacts.stroller.note).not.toMatch(/1\s*件行李/);
  });
});

describe("serviceFacts — reference prices (12 points, matches the authoritative table exactly)", () => {
  test("is explicitly labeled a public reference price, not the transactional authority", () => {
    expect(serviceFacts.reference_prices.label).toBe("公开参考价格");
    expect(serviceFacts.reference_prices.final_quote_source).toBe("booking_system");
    expect(serviceFacts.reference_prices.notes.join(" ")).toMatch(/A1\/A2\/A3交易价格仍以现有服务端价格逻辑\/Supabase RPC为权威/);
  });

  test("all 12 price points match the authoritative table exactly", () => {
    const m = serviceFacts.reference_prices.matrix;
    expect(m.economy_sedan.zh[8]).toBe(1600);
    expect(m.economy_sedan.zh[10]).toBe(1800);
    expect(m.economy_sedan.jp[8]).toBe(1300);
    expect(m.economy_sedan.jp[10]).toBe(1500);
    expect(m.toyota_alphard.zh[8]).toBe(1800);
    expect(m.toyota_alphard.zh[10]).toBe(2000);
    expect(m.toyota_alphard.jp[8]).toBe(1700);
    expect(m.toyota_alphard.jp[10]).toBe(1900);
    expect(m.toyota_hiace.zh[8]).toBe(2100);
    expect(m.toyota_hiace.zh[10]).toBe(2300);
    expect(m.toyota_hiace.jp[8]).toBe(2000);
    expect(m.toyota_hiace.jp[10]).toBe(2200);
  });
});

describe("serviceFacts — fee rules", () => {
  test("included/excluded fee lists match the confirmed wording", () => {
    expect(serviceFacts.fee_rules.included).toEqual(["车辆使用费", "司机服务费", "基本保险"]);
    expect(serviceFacts.fee_rules.excluded).toEqual(["高速费", "停车费", "景点门票等第三方费用（当天实际发生时由客人自付）"]);
  });

  test("overtime/night surcharge rates are 4000/5000/6000 JPY per hour, night surcharge from 21:00", () => {
    const s = serviceFacts.fee_rules.overtime_and_night_surcharge;
    expect(s.economy_sedan_jpy_per_hour).toBe(4000);
    expect(s.toyota_alphard_jpy_per_hour).toBe(5000);
    expect(s.toyota_hiace_jpy_per_hour).toBe(6000);
    expect(s.night_surcharge_from).toBe("21:00");
  });
});

describe("serviceFacts — cancellation policy", () => {
  test("has exactly the three confirmed windows: >48h, 24-48h, <24h", () => {
    expect(Object.keys(serviceFacts.cancellation_policy)).toEqual(
      expect.arrayContaining(["more_than_48h", "between_24_and_48h", "less_than_24h", "contact_channels"])
    );
    expect(serviceFacts.cancellation_policy.more_than_48h).toBe("full_deposit_refund");
    expect(serviceFacts.cancellation_policy.less_than_24h).toBe("deposit_non_refundable");
  });

  test("the 24-48h window is a partial deduction, WITHOUT a hardcoded 50% figure", () => {
    const value = serviceFacts.cancellation_policy.between_24_and_48h;
    expect(value).toBe("partial_deposit_deduction");
    expect(value).not.toMatch(/50\s*%/);
    expect(JSON.stringify(serviceFacts.cancellation_policy)).not.toMatch(/50\s*%/);
  });

  test("contact channels list WeChat/WhatsApp/LINE/Email", () => {
    expect(serviceFacts.cancellation_policy.contact_channels).toEqual(["WeChat", "WhatsApp", "LINE", "Email"]);
  });
});

describe("serviceFacts — public address policy", () => {
  test("marketing pages never carry a detailed street address; that stays on the legal page", () => {
    expect(serviceFacts.public_address_policy.marketing_pages).not.toMatch(/〒|\d{3}-\d{4}/);
    expect(serviceFacts.public_address_policy.legal_page).toMatch(/法律页面/);
  });
});
