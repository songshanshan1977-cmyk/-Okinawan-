const { test, expect } = require("@playwright/test");
const { createApiMock, assertNoForbiddenExternalRequests } = require("./helpers/apiMock");
const { installFixedClock, runStep1, fillStep2, clickStep2Next } = require("./helpers/bookingFlow");

test.describe("场景6: 单日回归", () => {
  test("单日有车：start_date=end_date，请求含完整范围，进入 Step3", async ({ page }) => {
    const mock = createApiMock();
    mock.setResponder("getCarPrice", () => ({ status: 200, body: { price: 1600 } }));
    mock.setResponder("checkInventory", () => ({
      status: 200,
      body: { available: true, unavailable_dates: [], checked: { start_date: "2026-07-20", end_date: "2026-07-20", days_count: 1 } },
    }));

    await installFixedClock(page);
    await mock.install(page);

    await page.goto("/booking");
    await runStep1(page, { startDay: 20, endDay: 20 }); // 同一天
    await fillStep2({ page, car: "car1", driverLang: "zh", duration: 8 });
    await clickStep2Next(page);

    expect(mock.calls.checkInventory.length).toBe(1);
    const req = mock.calls.checkInventory[0].body;
    expect(req.start_date).toBe("2026-07-20");
    expect(req.end_date).toBe("2026-07-20"); // 完整范围（start=end），不是省略 end_date

    await expect(page.getByText("Step3")).toBeVisible();
    assertNoForbiddenExternalRequests(mock);
  });

  test("单日无车：正常阻断，停留 Step2", async ({ page }) => {
    const mock = createApiMock();
    mock.setResponder("getCarPrice", () => ({ status: 200, body: { price: 1600 } }));
    mock.setResponder("checkInventory", () => ({
      status: 200,
      body: { available: false, unavailable_dates: [{ date: "2026-07-20", reason: "sold_out" }], checked: { start_date: "2026-07-20", end_date: "2026-07-20", days_count: 1 } },
    }));

    await installFixedClock(page);
    await mock.install(page);

    await page.goto("/booking");
    await runStep1(page, { startDay: 20, endDay: 20 });
    await fillStep2({ page, car: "car1", driverLang: "zh", duration: 8 });
    await clickStep2Next(page);

    await expect(page.getByText("该日期该车型暂无车辆")).toBeVisible();
    await expect(page.getByText("Step3")).toHaveCount(0);
    // 单日场景（start===end）应显示原有单日文案，而不是"连续日期"多日文案
    await expect(page.getByText("请尝试更换其他车型，或返回上一步修改用车日期。")).toBeVisible();

    assertNoForbiddenExternalRequests(mock);
  });
});
