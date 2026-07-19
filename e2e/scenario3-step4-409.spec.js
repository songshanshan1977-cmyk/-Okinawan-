const { test, expect } = require("@playwright/test");
const { createApiMock, assertNoForbiddenExternalRequests } = require("./helpers/apiMock");
const { installFixedClock, runStep1, fillStep2, clickStep2Next } = require("./helpers/bookingFlow");

test.describe("场景3: Step2 通过，Step4 付款前变为无车", () => {
  test("create-payment-intent 返回 409，页面不跳转，Step4 显示提示与日期，返回按钮可用", async ({ page }) => {
    const mock = createApiMock();

    mock.setResponder("getCarPrice", () => ({ status: 200, body: { price: 1600 } }));
    // Step2 检查时一切正常
    mock.setResponder("checkInventory", () => ({
      status: 200,
      body: { available: true, unavailable_dates: [], checked: { start_date: "2026-07-20", end_date: "2026-07-23", days_count: 4 } },
    }));
    mock.setResponder("createOrder", ({ body }) => ({
      status: 200,
      body: { success: true, reused: false, updated: false, order: { ...body } },
    }));
    // 付款前的第二次检查发现某天已被抢光
    mock.setResponder("createPaymentIntent", () => ({
      status: 409,
      body: { error: "inventory_unavailable", unavailable_dates: [{ date: "2026-07-22", reason: "sold_out" }] },
    }));

    await installFixedClock(page);
    await mock.install(page);

    await page.goto("/booking");
    await runStep1(page, { startDay: 20, endDay: 23 });
    await fillStep2({ page, car: "car1", driverLang: "zh", duration: 8 });
    await clickStep2Next(page);

    await expect(page.getByText("Step3")).toBeVisible();
    await page.getByText("确认并前往支付").click();

    await expect(page.getByText("Step4")).toBeVisible();
    await page.getByRole("button", { name: "前往 Stripe 支付押金" }).click();

    // 页面不跳转（仍在 /booking，不是 mock-stripe-checkout）
    await page.waitForTimeout(500);
    expect(page.url()).not.toContain("mock-stripe-checkout");
    await expect(page.getByText("Step4")).toBeVisible();

    // Step4 显示相同提示和具体日期
    await expect(page.getByText("该日期该车型暂无车辆")).toBeVisible();
    await expect(page.getByText("暂无车辆的日期：")).toBeVisible();
    await expect(page.getByText("2026-07-22")).toBeVisible();

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/inventory_unavailable/);
    expect(bodyText).not.toMatch(/sold_out/);

    // 现有返回按钮可用
    await expect(page.getByRole("button", { name: "返回上一步" })).toBeEnabled();

    // 无真实 Stripe 调用
    expect(mock.calls.createPaymentIntent.length).toBe(1);
    assertNoForbiddenExternalRequests(mock);
  });
});
