// e2e/helpers/bookingFlow.js
// Shared page-object-ish helpers for driving the real BookingFlow UI.
// Selectors deliberately avoid any production-code change (no test ids
// added) — they use the DOM structure and stable option `value`s that
// already exist in components/steps/Step1.jsx / Step2.jsx.

const { translations } = require("../../lib/i18n/bookingTranslations");

const CAR_MODEL_IDS = {
  car1: "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca",
  car2: "82cf604f-e688-49fe-aecf-69894a01f6cb",
  car3: "453df662-d350-4ab9-b811-61ffcda40d4b",
};

// Fixed "today" for every scenario, via Playwright's clock API, so date
// picking never depends on the real wall-clock date the test happens to
// run on. Wednesday 2026-07-15.
const FIXED_TODAY_ISO = "2026-07-15T00:00:00";

async function installFixedClock(page) {
  await page.clock.install({ time: new Date(FIXED_TODAY_ISO) });
}

// Click a specific day-of-month inside the Nth calendar box (0 = start date, 1 = end date).
async function pickDay(page, calBoxIndex, day) {
  const calBox = page.locator(".calBox").nth(calBoxIndex);
  await calBox.getByRole("gridcell", { name: String(day), exact: true }).click();
}

async function runStep1(page, { startDay, endDay, departureHotel = "Hotel A", endHotel = "Hotel B" } = {}) {
  await pickDay(page, 0, startDay);
  await pickDay(page, 1, endDay);
  const inputs = page.locator("input.input");
  await inputs.nth(0).fill(departureHotel);
  await inputs.nth(1).fill(endHotel);
  await page.getByRole("button", { name: translations.zh.btnNext }).click();
}

async function fillStep2({ page, car = "car1", driverLang = "zh", duration = 8, name = "Test User", phone = "080-1234-5678", email = "test@example.com" } = {}) {
  const t = translations.zh;
  const carLabel = { car1: t.carName_car1, car2: t.carName_car2, car3: t.carName_car3 }[car];
  await page.getByText(carLabel, { exact: true }).click();

  const selects = page.locator("select");
  await selects.nth(0).selectOption(driverLang); // 司机语言
  await selects.nth(1).selectOption(String(duration)); // 时长

  await page.getByPlaceholder(t.s2PlaceholderName).fill(name);
  await page.getByPlaceholder(t.s2PlaceholderPhone).fill(phone);
  await page.getByPlaceholder(t.s2PlaceholderEmail).fill(email);
}

async function clickStep2Next(page) {
  await page.getByRole("button", { name: translations.zh.s2BtnNextInfo }).click();
}

module.exports = { CAR_MODEL_IDS, FIXED_TODAY_ISO, installFixedClock, pickDay, runStep1, fillStep2, clickStep2Next };
