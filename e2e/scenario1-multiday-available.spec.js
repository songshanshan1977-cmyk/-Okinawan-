const { test, expect } = require("@playwright/test");
const { createApiMock, assertNoForbiddenExternalRequests } = require("./helpers/apiMock");
const { CAR_MODEL_IDS, installFixedClock, runStep1, fillStep2, clickStep2Next } = require("./helpers/bookingFlow");

test.describe("场景1: 多日全部有车", () => {
  test("完整走完 Step1→Step4，check-inventory 带完整区间，create-payment-intent 返回 Mock URL", async ({ page }) => {
    const mock = createApiMock();

    mock.setResponder("getCarPrice", () => ({ status: 200, body: { price: 1600 } }));
    mock.setResponder("checkInventory", () => ({
      status: 200,
      body: { available: true, unavailable_dates: [], checked: { start_date: "2026-07-20", end_date: "2026-07-23", days_count: 4 } },
    }));
    mock.setResponder("createOrder", ({ body }) => ({
      status: 200,
      body: { success: true, reused: false, updated: false, order: { ...body, order_id: body.order_id } },
    }));
    mock.setResponder("createPaymentIntent", () => ({
      status: 200,
      body: { url: "http://localhost:3100/mock-stripe-checkout", stripe_session_id: "cs_mock_1", order_id: "mock" },
    }));

    await installFixedClock(page);
    await mock.install(page);

    await page.goto("/booking");

    await runStep1(page, { startDay: 20, endDay: 23 }); // 2026-07-20 ~ 2026-07-23（4天）
    await fillStep2({ page, car: "car1", driverLang: "zh", duration: 8 });
    await clickStep2Next(page);

    // check-inventory 必须带完整区间
    expect(mock.calls.checkInventory.length).toBeGreaterThan(0);
    const lastCheck = mock.calls.checkInventory.at(-1).body;
    expect(lastCheck.start_date).toBe("2026-07-20");
    expect(lastCheck.end_date).toBe("2026-07-23");
    expect(lastCheck.car_model_id).toBe(CAR_MODEL_IDS.car1);

    // 进入 Step3
    await expect(page.getByText("Step3")).toBeVisible();
    await page.getByText("确认并前往支付").click();

    // 进入 Step4，点击支付
    await expect(page.getByText("Step4")).toBeVisible();
    await page.getByRole("button", { name: "前往 Stripe 支付押金" }).click();

    // create-order 收到完整最新字段
    expect(mock.calls.createOrder.length).toBe(1);
    const orderBody = mock.calls.createOrder[0].body;
    expect(orderBody.start_date).toBe("2026-07-20");
    expect(orderBody.end_date).toBe("2026-07-23");
    expect(orderBody.car_model_id).toBe(CAR_MODEL_IDS.car1);

    // create-payment-intent 成功返回 Mock URL，页面发起跳转意图
    await page.waitForURL(/mock-stripe-checkout/, { timeout: 5000 });
    expect(page.url()).toContain("mock-stripe-checkout");

    expect(mock.calls.createPaymentIntent.length).toBe(1);

    // 不访问 stripe.com / supabase.co / vercel.app / 生产预约域名
    assertNoForbiddenExternalRequests(mock);
  });
});
