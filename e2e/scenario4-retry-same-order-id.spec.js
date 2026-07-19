const { test, expect } = require("@playwright/test");
const { createApiMock, assertNoForbiddenExternalRequests } = require("./helpers/apiMock");
const { installFixedClock, runStep1, fillStep2, clickStep2Next } = require("./helpers/bookingFlow");

// v6: "改期后保持同一 order_id" 规则已作废（BLOCKING-1 修复）。
// 新规则：第二次提交仍带旧 order_id A，但服务端识别内容变化后创建独立新草稿 B，
// A 不会被修改；前端必须把最终 order_id 同步回父级 BookingFlow 状态。
test.describe("场景4（v6 重写）: 服务端因内容变化拒绝复用旧ID，改为创建新草稿 B", () => {
  test("A 完全不变，创建独立 B，B 同步回父级状态用于后续请求，不产生第三条订单", async ({ page }) => {
    const mock = createApiMock();
    const orderIdA = { value: null };
    const orderIdB = "ORD-20260715-99999";

    mock.setResponder("getCarPrice", () => ({ status: 200, body: { price: 1600 } }));
    mock.setResponder("checkInventory", () => ({
      status: 200,
      body: { available: true, unavailable_dates: [], checked: { start_date: "x", end_date: "y", days_count: 1 } },
    }));

    mock.setResponder("createOrder", ({ body, callIndex }) => {
      if (callIndex === 0) {
        // 第一次：全新 order_id，首次入库为 draft A
        orderIdA.value = body.order_id;
        return {
          status: 200,
          body: { success: true, reused: false, created_new_order: false, order: { ...body, order_id: body.order_id, payment_status: "draft" } },
        };
      }
      // 第二次：请求体里仍是 A（页面还没被告知过任何新ID），但日期已变——
      // 模拟服务端识别内容不同，创建独立新草稿 B，A 保持不变
      expect(body.order_id).toBe(orderIdA.value); // 页面确实还在提交旧ID A
      return {
        status: 200,
        body: {
          success: true,
          reused: false,
          created_new_order: true,
          previous_order_id: orderIdA.value,
          order: { ...body, order_id: orderIdB, payment_status: "draft" },
        },
      };
    });

    // 全程 409：保证页面停留在 Step4，便于稳定断言最终展示的 order_id 已同步为 B
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
    await page.getByText("确认并前往支付").click();

    // 第一次支付尝试：create-order 创建 A，create-payment-intent 409
    await page.getByRole("button", { name: "前往 Stripe 支付押金" }).click();
    await expect(page.getByText("暂无车辆的日期：")).toBeVisible();
    expect(mock.calls.createOrder.length).toBe(1);
    expect(page.url()).not.toContain("mock-stripe-checkout");

    // 用现有返回流程回到 Step1 修改日期
    await page.getByRole("button", { name: "返回上一步" }).click(); // Step4 -> Step3
    await page.getByText("返回修改").click(); // Step3 -> Step2
    await page.getByRole("button", { name: "返回上一步" }).click(); // Step2 -> Step1
    await runStep1(page, { startDay: 25, endDay: 27 }); // 改成新日期
    await fillStep2({ page, car: "car1", driverLang: "zh", duration: 8 });
    await clickStep2Next(page);
    await page.getByText("确认并前往支付").click();

    // 第二次支付尝试：页面仍提交旧ID A，服务端返回新草稿 B
    await page.getByRole("button", { name: "前往 Stripe 支付押金" }).click();
    await expect(page.getByText("暂无车辆的日期：")).toBeVisible();

    // 恰好两次 create-order：A 的创建 + B 的创建，没有第三条订单
    expect(mock.calls.createOrder.length).toBe(2);
    expect(mock.calls.createOrder[1].body.order_id).toBe(orderIdA.value); // 页面提交的仍是旧ID
    expect(orderIdB).not.toBe(orderIdA.value); // B != A

    // Step4 页面展示已同步为最新的 order_id B（不再展示旧的 A）
    await expect(page.getByText(orderIdB, { exact: false })).toBeVisible();
    await expect(page.getByText(orderIdA.value, { exact: false })).toHaveCount(0);

    // create-payment-intent 的第二次调用使用的是 B
    expect(mock.calls.createPaymentIntent.length).toBe(2);
    expect(mock.calls.createPaymentIntent[1].body.orderId).toBe(orderIdB);

    assertNoForbiddenExternalRequests(mock);
  });
});
