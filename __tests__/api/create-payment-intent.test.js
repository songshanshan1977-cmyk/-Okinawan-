const { createMockSupabase } = require("../helpers/mockSupabase");
const { createMockReq, createMockRes } = require("../helpers/mockReqRes");

function loadHandler({ supabase, stripeSessionsCreate }) {
  let handler;
  const stripeConstructor = jest.fn(() => ({
    checkout: { sessions: { create: stripeSessionsCreate } },
  }));

  jest.isolateModules(() => {
    jest.doMock("@supabase/supabase-js", () => ({
      createClient: jest.fn(() => supabase),
    }));
    jest.doMock("stripe", () => stripeConstructor);
    const mod = require("../../pages/api/create-payment-intent");
    handler = mod.default || mod;
  });

  return { handler, stripeConstructor };
}

function row(date, remaining) {
  return { date, remaining_qty_calc: remaining };
}

const ORDER = {
  order_id: "ORD-20260802-11111",
  deposit_amount: 500,
  start_date: "2026-08-02",
  end_date: "2026-08-05",
  car_model_id: "car-1",
  driver_lang: "ZH",
};

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://sandbox.invalid";
});

describe("POST /api/create-payment-intent — 冻结规则 4.4 / 9", () => {
  test("库存全部可用 -> 创建且仅创建一次 Stripe Session（Mock 调用证据）", async () => {
    const stripeSessionsCreate = jest.fn(() =>
      Promise.resolve({ id: "cs_test_mock_123", url: "https://stripe.invalid/pay/cs_test_mock_123" })
    );
    const supabase = createMockSupabase({
      from: {
        orders: { data: ORDER, error: null },
        inventory_rules_v2: {
          data: [row("2026-08-02", 3), row("2026-08-03", 2), row("2026-08-04", 1), row("2026-08-05", 5)],
          error: null,
        },
      },
    });
    const { handler } = loadHandler({ supabase, stripeSessionsCreate });

    const req = createMockReq({ body: { orderId: ORDER.order_id } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.url).toBe("https://stripe.invalid/pay/cs_test_mock_123");
    expect(stripeSessionsCreate).toHaveBeenCalledTimes(1);
    const callArgs = stripeSessionsCreate.mock.calls[0][0];
    expect(callArgs.success_url).toContain(`step=5&order_id=${ORDER.order_id}`);
    expect(callArgs.cancel_url).toContain(`step=4&order_id=${ORDER.order_id}`);
  });

  test("case 07: Step2通过后、创建Stripe前库存被改成0 -> 409，且 Stripe 创建函数调用次数为0", async () => {
    const stripeSessionsCreate = jest.fn(() =>
      Promise.resolve({ id: "cs_should_not_be_called", url: "https://stripe.invalid/should-not-happen" })
    );
    const supabase = createMockSupabase({
      from: {
        orders: { data: ORDER, error: null },
        inventory_rules_v2: {
          // 2026-08-04 被后台改成 0
          data: [row("2026-08-02", 3), row("2026-08-03", 2), row("2026-08-04", 0), row("2026-08-05", 5)],
          error: null,
        },
      },
    });
    const { handler } = loadHandler({ supabase, stripeSessionsCreate });

    const req = createMockReq({ body: { orderId: ORDER.order_id } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("inventory_unavailable");
    expect(res.body.unavailable_dates).toEqual([{ date: "2026-08-04", reason: "sold_out" }]);

    // case 10: 无车时 Stripe Session 创建函数调用次数为 0
    expect(stripeSessionsCreate).toHaveBeenCalledTimes(0);

    // 不改订单状态、不写 stripe_session_id（orders.update 从未被调用）
    expect(supabase.__calls.from.filter((t) => t === "orders").length).toBe(1); // 只有最初那次 select
  });

  test("库存缺行同样阻止创建 Stripe Session（inventory_missing）", async () => {
    const stripeSessionsCreate = jest.fn();
    const supabase = createMockSupabase({
      from: {
        orders: { data: ORDER, error: null },
        inventory_rules_v2: {
          data: [row("2026-08-02", 3), row("2026-08-03", 2), row("2026-08-05", 5)], // 缺 08-04
          error: null,
        },
      },
    });
    const { handler } = loadHandler({ supabase, stripeSessionsCreate });

    const req = createMockReq({ body: { orderId: ORDER.order_id } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.unavailable_dates).toEqual([{ date: "2026-08-04", reason: "inventory_missing" }]);
    expect(stripeSessionsCreate).toHaveBeenCalledTimes(0);
  });

  test("订单不存在 -> 404，不创建 Session", async () => {
    const stripeSessionsCreate = jest.fn();
    const supabase = createMockSupabase({
      from: { orders: { data: null, error: { message: "not found" } } },
    });
    const { handler } = loadHandler({ supabase, stripeSessionsCreate });

    const req = createMockReq({ body: { orderId: "does-not-exist" } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(stripeSessionsCreate).toHaveBeenCalledTimes(0);
  });

  test("缺 orderId -> 400，不创建 Session", async () => {
    const stripeSessionsCreate = jest.fn();
    const supabase = createMockSupabase({ from: { orders: { data: ORDER, error: null } } });
    const { handler } = loadHandler({ supabase, stripeSessionsCreate });

    const req = createMockReq({ body: {} });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(stripeSessionsCreate).toHaveBeenCalledTimes(0);
  });
});
