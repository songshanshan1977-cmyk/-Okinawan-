const { test, expect } = require("@playwright/test");
const { createApiMock, assertNoForbiddenExternalRequests } = require("./helpers/apiMock");
const { installFixedClock, runStep1, fillStep2, clickStep2Next } = require("./helpers/bookingFlow");

test.describe("场景2: Step2 发现部分日期无车", () => {
  test("停留 Step2，显示统一提示与具体日期，不发起 create-order/create-payment-intent", async ({ page }) => {
    const mock = createApiMock();

    mock.setResponder("getCarPrice", () => ({ status: 200, body: { price: 1600 } }));
    mock.setResponder("checkInventory", () => ({
      status: 200,
      body: {
        available: false,
        unavailable_dates: [
          { date: "2026-07-21", reason: "inventory_missing" },
          { date: "2026-07-22", reason: "sold_out" },
        ],
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

    // 停留 Step2，不进入 Step3
    await expect(page.getByText("该日期该车型暂无车辆")).toBeVisible();
    await expect(page.getByText("Step3")).toHaveCount(0);

    // 显示统一提示（多日区间文案）
    await expect(
      page.getByText("您选择的连续日期中，部分日期暂无可用车辆。您可以调整日期、车型或司机语言，也可以将行程拆成单日分别查询。拆分预约后，每天的车辆、司机和价格可能不同。")
    ).toBeVisible();

    // 显示具体日期
    await expect(page.getByText("暂无车辆的日期：")).toBeVisible();
    await expect(page.getByText("2026-07-21、2026-07-22")).toBeVisible();

    // 客户页面不显示技术原文
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/inventory_missing/);
    expect(bodyText).not.toMatch(/sold_out/);

    // 不出现新按钮：仍然只有"返回上一步"和"下一步：填写信息"两个按钮
    const buttonTexts = await page.getByRole("button").allInnerTexts();
    const bookingButtons = buttonTexts.filter((t) => !["简体中文", "繁體中文", "日本語", "English", "한국어"].includes(t));
    expect(bookingButtons.sort()).toEqual(["下一步：填写信息", "返回上一步"].sort());

    // create-order / create-payment-intent 调用次数为 0
    expect(mock.calls.createOrder.length).toBe(0);
    expect(mock.calls.createPaymentIntent.length).toBe(0);

    assertNoForbiddenExternalRequests(mock);
  });
});
