const { test, expect } = require("@playwright/test");
const { createApiMock, assertNoForbiddenExternalRequests } = require("./helpers/apiMock");
const { installFixedClock, runStep1, fillStep2, clickStep2Next } = require("./helpers/bookingFlow");

test.describe("场景4: 返回修改后使用同一 order_id 重试", () => {
  test("Step4 收到409 -> 走现有返回流程改日期 -> 第二次 create-order 同 order_id、新日期", async ({ page }) => {
    const mock = createApiMock();

    mock.setResponder("getCarPrice", () => ({ status: 200, body: { price: 1600 } }));
    mock.setResponder("checkInventory", () => ({
      status: 200,
      body: { available: true, unavailable_dates: [], checked: { start_date: "x", end_date: "y", days_count: 1 } },
    }));
    mock.setResponder("createOrder", ({ body }) => ({
      status: 200,
      body: { success: true, reused: mock.calls.createOrder.length > 1, updated: mock.calls.createOrder.length > 1, order: { ...body } },
    }));
    // 第一次付款前检查：409（触发返回修改）；第二次：成功
    mock.setResponder("createPaymentIntent", ({ callIndex }) => {
      if (callIndex === 0) {
        return { status: 409, body: { error: "inventory_unavailable", unavailable_dates: [{ date: "2026-07-22", reason: "sold_out" }] } };
      }
      return { status: 200, body: { url: "http://localhost:3100/mock-stripe-checkout" } };
    });

    await installFixedClock(page);
    await mock.install(page);

    await page.goto("/booking");
    await runStep1(page, { startDay: 20, endDay: 23 }); // 第一次：2026-07-20 ~ 23
    await fillStep2({ page, car: "car1", driverLang: "zh", duration: 8 });
    await clickStep2Next(page);
    await page.getByText("确认并前往支付").click();
    await page.getByRole("button", { name: "前往 Stripe 支付押金" }).click();

    // 收到 409，停留 Step4
    await expect(page.getByText("暂无车辆的日期：")).toBeVisible();
    expect(mock.calls.createOrder.length).toBe(1);
    const firstOrderId = mock.calls.createOrder[0].body.order_id;
    expect(mock.calls.createOrder[0].body.start_date).toBe("2026-07-20");

    // 用现有返回流程：Step4 -> Step3 -> Step2 -> Step1
    await page.getByRole("button", { name: "返回上一步" }).click(); // Step4 -> Step3
    await expect(page.getByText("Step3")).toBeVisible();
    await page.getByText("返回修改").click(); // Step3 -> Step2
    await expect(page.locator("h2", { hasText: "Step2" })).toBeVisible();
    await page.getByRole("button", { name: "返回上一步" }).click(); // Step2 -> Step1
    await expect(page.getByText("立即预订")).toBeVisible();

    // 修改日期后重新前进
    await runStep1(page, { startDay: 24, endDay: 25 }); // 改成 2026-07-24 ~ 25
    await fillStep2({ page, car: "car1", driverLang: "zh", duration: 8 });
    await clickStep2Next(page);
    await page.getByText("确认并前往支付").click();
    await page.getByRole("button", { name: "前往 Stripe 支付押金" }).click();

    await page.waitForURL(/mock-stripe-checkout/, { timeout: 5000 });

    // create-order 第二次请求：order_id 相同，日期是修改后的新值
    expect(mock.calls.createOrder.length).toBe(2);
    const secondOrderId = mock.calls.createOrder[1].body.order_id;
    expect(secondOrderId).toBe(firstOrderId); // 不新增订单号
    expect(mock.calls.createOrder[1].body.start_date).toBe("2026-07-24");
    expect(mock.calls.createOrder[1].body.end_date).toBe("2026-07-25");

    // create-payment-intent 对应最新订单数据
    expect(mock.calls.createPaymentIntent.length).toBe(2);

    assertNoForbiddenExternalRequests(mock);
  });
});
