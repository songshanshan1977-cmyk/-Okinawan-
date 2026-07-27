const {
  validateAvailabilityInput,
  validateQuoteInput,
  validateDraftInput,
  normalizeDriverLangStrict,
  isRealYMD,
  isSameDayInTokyo,
  isPositiveInteger,
  isNonNegativeInteger,
} = require("../../../lib/agent/validation/validateBookingInput");

const CAR = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca"; // valid, from calcTotalPrice.js VALID_CAR_MODEL_IDS

const VALID_DRAFT = {
  car_model_id: CAR,
  driver_lang: "zh",
  duration: 8,
  start_date: "2099-09-01",
  end_date: "2099-09-01",
  departure_hotel: "Hotel A",
  end_hotel: "Hotel B",
  pax: 2,
  luggage: 1,
  name: "Zhang San",
  phone: "13800000000",
  email: "zhangsan@example.com",
};

describe("validateBookingInput — shared primitives", () => {
  describe("normalizeDriverLangStrict", () => {
    test.each(["zh", "jp", "ZH", "JP"])("%s is accepted", (v) => {
      expect(normalizeDriverLangStrict(v)).not.toBeNull();
    });
    test.each(["Zh", "zH", "ja", "jpn", "JPN", "", null, undefined, 123, "fr"])("%s is rejected, never defaulted", (v) => {
      expect(normalizeDriverLangStrict(v)).toBeNull();
    });
  });

  describe("isRealYMD", () => {
    test("rejects Feb 30 (does not silently roll over to March)", () => {
      expect(isRealYMD("2026-02-30")).toBe(false);
    });
    test("rejects Apr 31", () => {
      expect(isRealYMD("2026-04-31")).toBe(false);
    });
    test("accepts Feb 29 in a real leap year (2028)", () => {
      expect(isRealYMD("2028-02-29")).toBe(true);
    });
    test("rejects Feb 29 in a non-leap year (2026)", () => {
      expect(isRealYMD("2026-02-29")).toBe(false);
    });
    test("rejects month 13 / day 32 / day 00 / month 00", () => {
      expect(isRealYMD("2026-13-01")).toBe(false);
      expect(isRealYMD("2026-01-32")).toBe(false);
      expect(isRealYMD("2026-01-00")).toBe(false);
      expect(isRealYMD("2026-00-01")).toBe(false);
    });
    test("rejects non-YYYY-MM-DD shapes", () => {
      expect(isRealYMD("2026/09/01")).toBe(false);
      expect(isRealYMD("2026-9-1")).toBe(false);
      expect(isRealYMD("")).toBe(false);
      expect(isRealYMD(undefined)).toBe(false);
      expect(isRealYMD(null)).toBe(false);
      expect(isRealYMD(20260901)).toBe(false);
    });
    test("accepts a genuine valid date", () => {
      expect(isRealYMD("2026-09-01")).toBe(true);
    });
  });

  describe("isSameDayInTokyo", () => {
    test("18:00 UTC on 2026-07-27 is already 2026-07-28 03:00 in Tokyo (UTC+9) -> same-day check uses Tokyo's date, not UTC's", () => {
      const now = new Date("2026-07-27T18:00:00Z");
      expect(isSameDayInTokyo("2026-07-28", now)).toBe(true);
      expect(isSameDayInTokyo("2026-07-27", now)).toBe(false);
    });
    test("just before Tokyo midnight rollover: 14:59 UTC is still 2026-07-27 23:59 in Tokyo", () => {
      const now = new Date("2026-07-27T14:59:00Z");
      expect(isSameDayInTokyo("2026-07-27", now)).toBe(true);
    });
    test("a future date is never same-day", () => {
      const now = new Date("2026-07-27T00:00:00Z");
      expect(isSameDayInTokyo("2026-08-01", now)).toBe(false);
    });
  });

  describe("integer checks", () => {
    test("isPositiveInteger", () => {
      expect(isPositiveInteger(1)).toBe(true);
      expect(isPositiveInteger("2")).toBe(true);
      expect(isPositiveInteger(0)).toBe(false);
      expect(isPositiveInteger(-1)).toBe(false);
      expect(isPositiveInteger(1.5)).toBe(false);
      expect(isPositiveInteger("abc")).toBe(false);
      expect(isPositiveInteger(null)).toBe(false);
    });
    test("isNonNegativeInteger", () => {
      expect(isNonNegativeInteger(0)).toBe(true);
      expect(isNonNegativeInteger("0")).toBe(true);
      expect(isNonNegativeInteger(-1)).toBe(false);
      expect(isNonNegativeInteger(1.5)).toBe(false);
    });
  });
});

describe("validateAvailabilityInput", () => {
  test("accepts a fully valid request", () => {
    expect(validateAvailabilityInput({ car_model_id: CAR, driver_lang: "ZH", start_date: "2099-09-01", end_date: "2099-09-01" }).ok).toBe(true);
  });
  test("rejects a non-plain-object body (array/null/string)", () => {
    expect(validateAvailabilityInput(null).ok).toBe(false);
    expect(validateAvailabilityInput([]).ok).toBe(false);
    expect(validateAvailabilityInput("x").ok).toBe(false);
  });
  test("rejects an unknown car_model_id", () => {
    expect(validateAvailabilityInput({ car_model_id: "not-a-real-car", driver_lang: "ZH", start_date: "2099-09-01", end_date: "2099-09-01" }).ok).toBe(false);
  });
  test("rejects end_date < start_date", () => {
    expect(validateAvailabilityInput({ car_model_id: CAR, driver_lang: "ZH", start_date: "2099-09-05", end_date: "2099-09-01" }).ok).toBe(false);
  });
  test("does NOT reject same-day (availability lookup is not a booking action)", () => {
    // start_date equal to "today" in Tokyo — availability alone must not enforce the same-day booking rule.
    const today = require("../../../lib/agent/validation/validateBookingInput").todayInTokyoYMD(new Date());
    expect(validateAvailabilityInput({ car_model_id: CAR, driver_lang: "ZH", start_date: today, end_date: today }).ok).toBe(true);
  });
});

describe("validateQuoteInput", () => {
  const FUTURE = { start_date: "2099-09-01", end_date: "2099-09-01" };

  test("accepts a fully valid request", () => {
    expect(validateQuoteInput({ car_model_id: CAR, driver_lang: "ZH", duration: 8, ...FUTURE }).ok).toBe(true);
  });
  test("REQUIRES end_date explicitly — omitting it is rejected, never defaulted to start_date", () => {
    const result = validateQuoteInput({ car_model_id: CAR, driver_lang: "ZH", duration: 8, start_date: "2099-09-01" });
    expect(result.ok).toBe(false);
  });
  test("rejects duration other than 8/10", () => {
    expect(validateQuoteInput({ car_model_id: CAR, driver_lang: "ZH", duration: 9, ...FUTURE }).ok).toBe(false);
  });
  test("rejects a fake calendar date (Feb 30)", () => {
    expect(validateQuoteInput({ car_model_id: CAR, driver_lang: "ZH", duration: 8, start_date: "2099-02-30", end_date: "2099-02-30" }).ok).toBe(false);
  });
  test("rejects same-day booking in Asia/Tokyo", () => {
    const today = require("../../../lib/agent/validation/validateBookingInput").todayInTokyoYMD(new Date());
    expect(validateQuoteInput({ car_model_id: CAR, driver_lang: "ZH", duration: 8, start_date: today, end_date: today }).ok).toBe(false);
  });
});

describe("validateDraftInput", () => {
  test("accepts a fully valid request", () => {
    expect(validateDraftInput(VALID_DRAFT).ok).toBe(true);
  });

  test("A1-B01: existing_order_id present at all -> rejected", () => {
    expect(validateDraftInput({ ...VALID_DRAFT, existing_order_id: "ORD-1" }).ok).toBe(false);
  });
  test("A1-B01: order_id present at all -> rejected", () => {
    expect(validateDraftInput({ ...VALID_DRAFT, order_id: "ORD-1" }).ok).toBe(false);
  });

  test("rejects pax = 0 or negative or non-integer", () => {
    expect(validateDraftInput({ ...VALID_DRAFT, pax: 0 }).ok).toBe(false);
    expect(validateDraftInput({ ...VALID_DRAFT, pax: -1 }).ok).toBe(false);
    expect(validateDraftInput({ ...VALID_DRAFT, pax: 1.5 }).ok).toBe(false);
  });
  test("accepts luggage = 0, rejects negative", () => {
    expect(validateDraftInput({ ...VALID_DRAFT, luggage: 0 }).ok).toBe(true);
    expect(validateDraftInput({ ...VALID_DRAFT, luggage: -1 }).ok).toBe(false);
  });
  test("rejects blank/whitespace-only required text", () => {
    expect(validateDraftInput({ ...VALID_DRAFT, name: "   " }).ok).toBe(false);
    expect(validateDraftInput({ ...VALID_DRAFT, departure_hotel: "" }).ok).toBe(false);
  });
  test("rejects a malformed email", () => {
    expect(validateDraftInput({ ...VALID_DRAFT, email: "not-an-email" }).ok).toBe(false);
  });
  test("rejects overlong text beyond the business-compatible cap", () => {
    expect(validateDraftInput({ ...VALID_DRAFT, remark: "x".repeat(3000) }).ok).toBe(false);
  });
  test("optional fields (wechat/itinerary/remark) may be omitted entirely", () => {
    const { wechat, itinerary, remark, ...withoutOptional } = VALID_DRAFT;
    expect(validateDraftInput(withoutOptional).ok).toBe(true);
  });
  test("rejects same-day booking in Asia/Tokyo", () => {
    const today = require("../../../lib/agent/validation/validateBookingInput").todayInTokyoYMD(new Date());
    expect(validateDraftInput({ ...VALID_DRAFT, start_date: today, end_date: today }).ok).toBe(false);
  });
  test("rejects a fake calendar date (Feb 30)", () => {
    expect(validateDraftInput({ ...VALID_DRAFT, start_date: "2099-02-30", end_date: "2099-02-30" }).ok).toBe(false);
  });
  test("rejects driver_lang alias 'ja' (not one of the 4 exact accepted spellings)", () => {
    expect(validateDraftInput({ ...VALID_DRAFT, driver_lang: "ja" }).ok).toBe(false);
  });
});
