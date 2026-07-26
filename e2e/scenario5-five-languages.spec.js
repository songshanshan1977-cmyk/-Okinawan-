const { test, expect } = require("@playwright/test");
const { createApiMock, assertNoForbiddenExternalRequests } = require("./helpers/apiMock");
const { installFixedClock, runStep1, fillStep2, clickStep2Next } = require("./helpers/bookingFlow");
const { translations } = require("../lib/i18n/bookingTranslations");

const LANG_BUTTONS = {
  zh: "简体中文",
  "zh-TW": "繁體中文",
  ja: "日本語",
  en: "English",
  ko: "한국어",
};

test.describe("场景5: 五语言", () => {
  for (const lang of Object.keys(LANG_BUTTONS)) {
    test(`${lang}: 区间无车提示、"无车日期"标签、日期列表均可见，无 undefined / 翻译key原文`, async ({ page }) => {
      const mock = createApiMock();

      mock.setResponder("getCarPrice", () => ({ status: 200, body: { price: 1600 } }));
      mock.setResponder("checkInventory", () => ({
        status: 200,
        body: {
          available: false,
          unavailable_dates: [{ date: "2026-07-21", reason: "inventory_missing" }],
          checked: { start_date: "2026-07-20", end_date: "2026-07-23", days_count: 4 },
        },
      }));
      mock.setResponder("createOrder", () => ({ status: 200, body: { success: true, order: {}, reused: false, updated: false } }));
      mock.setResponder("createPaymentIntent", () => ({ status: 200, body: { url: "http://localhost:3100/mock-stripe-checkout" } }));

      await installFixedClock(page);
      await mock.install(page);

      await page.goto("/booking");
      await runStep1(page, { startDay: 20, endDay: 23 });
      await fillStep2({ page, car: "car1", driverLang: "zh", duration: 8 });
      await clickStep2Next(page);
      await expect(page.getByText("2026-07-21")).toBeVisible(); // 先在默认语言(zh)确认已进入无车状态

      // 切换到目标语言（langSwitcher 只改显示文字，不影响 unavailableDates 状态）
      await page.getByRole("button", { name: LANG_BUTTONS[lang] }).click();

      const t = translations[lang];
      await expect(page.getByText(t.s2ErrRangeUnavailableMsg)).toBeVisible();
      await expect(page.getByText(t.s2UnavailableDatesLabel, { exact: false })).toBeVisible();
      await expect(page.getByText("2026-07-21")).toBeVisible(); // 日期列表本身不翻译，始终可见

      const bodyText = await page.locator("body").innerText();
      expect(bodyText).not.toMatch(/undefined/);
      // 不出现原始 key 名（形如 s2ErrRangeUnavailableMsg / s2UnavailableDatesLabel 字面量）
      expect(bodyText).not.toMatch(/s2ErrRangeUnavailableMsg|s2UnavailableDatesLabel/);

      assertNoForbiddenExternalRequests(mock);
    });
  }
});
