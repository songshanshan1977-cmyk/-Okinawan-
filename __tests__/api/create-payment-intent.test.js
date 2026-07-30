// __tests__/api/create-payment-intent.test.js
//
// A3 rewrite: this endpoint no longer trusts "knowing an orderId" — it must
// also hold a currently-valid, unconsumed, order-bound payment_token, which
// is consumed ATOMICALLY via the consume_payment_authorization_v1 RPC (see
// lib/payment/createCheckoutSession.js, the one function both this endpoint
// and lib/agent/tools/createPaymentLink.js call). Every test below drives
// the handler through that shared function via a mocked supabase.rpc, never
// through the old direct `.from("orders").select(...).single()` shape this
// file's previous version used.

const { createMockSupabase } = require("../helpers/mockSupabase");
const { createMockReq, createMockRes } = require("../helpers/mockReqRes");
const { computeSummaryHash } = require("../../lib/agent/bookingSummary");

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

const CONSUMED_ORDER_BASE = {
  order_id: "ORD-20260802-11111",
  start_date: "2026-08-02",
  end_date: "2026-08-05",
  car_model_id: "car-1",
  driver_lang: "ZH",
  duration: 8,
  pax: 2,
  luggage: 1,
  departure_hotel: "Hotel A",
  end_hotel: "Hotel B",
  total_price: 1600,
  deposit_amount: 500,
  payment_status: "draft",
  inventory_status: "pending",
};

const VALID_BOUND_HASH = computeSummaryHash(CONSUMED_ORDER_BASE);

// The row consume_payment_authorization_v1 would return for a still-valid,
// just-consumed authorization bound to CONSUMED_ORDER_BASE's current content.
function validConsumedRow(overrides = {}) {
  return {
    ...CONSUMED_ORDER_BASE,
    payment_authorization_summary_hash: VALID_BOUND_HASH,
    payment_authorization_deposit_amount: 500,
    ...overrides,
  };
}

const FULL_INVENTORY = [row("2026-08-02", 3), row("2026-08-03", 2), row("2026-08-04", 1), row("2026-08-05", 5)];

function mockSupabaseFor({ rpcResult, inventoryRows = FULL_INVENTORY }) {
  return createMockSupabase({
    from: {
      orders: { data: null, error: null }, // 只有 write-back update 会用到，值本身不影响断言
      inventory_rules_v2: { data: inventoryRows, error: null },
    },
    rpc: () => rpcResult,
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://sandbox.invalid";
});

describe("POST /api/create-payment-intent — A3：orderId 不再足够，必须持有有效 payment_token", () => {
  test("只有 orderId、缺 payment_token -> 400，RPC/Stripe 0 调用", async () => {
    const stripeSessionsCreate = jest.fn();
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null } });
    const { handler } = loadHandler({ supabase, stripeSessionsCreate });

    const req = createMockReq({ body: { orderId: CONSUMED_ORDER_BASE.order_id } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(supabase.__calls.rpc.length).toBe(0);
    expect(stripeSessionsCreate).toHaveBeenCalledTimes(0);
  });

  test("orderId 和 payment_token 都缺 -> 400，RPC/Stripe 0 调用", async () => {
    const stripeSessionsCreate = jest.fn();
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null } });
    const { handler } = loadHandler({ supabase, stripeSessionsCreate });

    const req = createMockReq({ body: {} });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(supabase.__calls.rpc.length).toBe(0);
    expect(stripeSessionsCreate).toHaveBeenCalledTimes(0);
  });

  test("Token 无效/过期/已被消费（RPC 无匹配行）-> 409 payment_authorization_expired_or_used，Stripe 0 调用", async () => {
    const stripeSessionsCreate = jest.fn();
    const supabase = mockSupabaseFor({ rpcResult: { data: [], error: null } });
    const { handler } = loadHandler({ supabase, stripeSessionsCreate });

    const req = createMockReq({ body: { orderId: CONSUMED_ORDER_BASE.order_id, payment_token: "raw-token-value-not-matching-anything" } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("payment_authorization_expired_or_used");
    expect(stripeSessionsCreate).toHaveBeenCalledTimes(0);
  });

  test("订单不存在同样表现为 RPC 无匹配行 -> 409 payment_authorization_expired_or_used（而不是 404）", async () => {
    const stripeSessionsCreate = jest.fn();
    const supabase = mockSupabaseFor({ rpcResult: { data: [], error: null } });
    const { handler } = loadHandler({ supabase, stripeSessionsCreate });

    const req = createMockReq({ body: { orderId: "does-not-exist", payment_token: "some-token" } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("payment_authorization_expired_or_used");
    expect(stripeSessionsCreate).toHaveBeenCalledTimes(0);
  });

  test("摘要已变化（RPC 返回行的实时 summary_hash 与授权绑定的 hash 不一致）-> 409 payment_summary_stale，Stripe 0 调用", async () => {
    const stripeSessionsCreate = jest.fn();
    // 内容变了（duration 8 -> 10），但 payment_authorization_summary_hash 仍是旧内容的 hash
    const staleRow = validConsumedRow({ duration: 10 });
    const supabase = mockSupabaseFor({ rpcResult: { data: [staleRow], error: null } });
    const { handler } = loadHandler({ supabase, stripeSessionsCreate });

    const req = createMockReq({ body: { orderId: CONSUMED_ORDER_BASE.order_id, payment_token: "some-token" } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("payment_summary_stale");
    expect(stripeSessionsCreate).toHaveBeenCalledTimes(0);
  });

  test("押金不是固定 500（payment_authorization_deposit_amount 被篡改为非 500）-> 409 payment_summary_stale，Stripe 0 调用", async () => {
    const stripeSessionsCreate = jest.fn();
    const badDepositRow = validConsumedRow({ payment_authorization_deposit_amount: 1 });
    const supabase = mockSupabaseFor({ rpcResult: { data: [badDepositRow], error: null } });
    const { handler } = loadHandler({ supabase, stripeSessionsCreate });

    const req = createMockReq({ body: { orderId: CONSUMED_ORDER_BASE.order_id, payment_token: "some-token" } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("payment_summary_stale");
    expect(stripeSessionsCreate).toHaveBeenCalledTimes(0);
  });

  test("库存被改成 0 -> 409 inventory_unavailable，Stripe 0 调用", async () => {
    const stripeSessionsCreate = jest.fn();
    const supabase = mockSupabaseFor({
      rpcResult: { data: [validConsumedRow()], error: null },
      inventoryRows: [row("2026-08-02", 3), row("2026-08-03", 2), row("2026-08-04", 0), row("2026-08-05", 5)],
    });
    const { handler } = loadHandler({ supabase, stripeSessionsCreate });

    const req = createMockReq({ body: { orderId: CONSUMED_ORDER_BASE.order_id, payment_token: "some-token" } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("inventory_unavailable");
    expect(res.body.unavailable_dates).toEqual([{ date: "2026-08-04", reason: "sold_out" }]);
    expect(stripeSessionsCreate).toHaveBeenCalledTimes(0);
  });

  test("库存缺行（inventory_missing）同样阻止创建 Session，Stripe 0 调用", async () => {
    const stripeSessionsCreate = jest.fn();
    const supabase = mockSupabaseFor({
      rpcResult: { data: [validConsumedRow()], error: null },
      inventoryRows: [row("2026-08-02", 3), row("2026-08-03", 2), row("2026-08-05", 5)], // 缺 08-04
    });
    const { handler } = loadHandler({ supabase, stripeSessionsCreate });

    const req = createMockReq({ body: { orderId: CONSUMED_ORDER_BASE.order_id, payment_token: "some-token" } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.unavailable_dates).toEqual([{ date: "2026-08-04", reason: "inventory_missing" }]);
    expect(stripeSessionsCreate).toHaveBeenCalledTimes(0);
  });

  test("有效授权 -> 恰好一次 Stripe 调用，金额固定 500 RMB，返回 URL", async () => {
    const stripeSessionsCreate = jest.fn(() =>
      Promise.resolve({ id: "cs_test_mock_123", url: "https://stripe.invalid/pay/cs_test_mock_123" })
    );
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null } });
    const { handler } = loadHandler({ supabase, stripeSessionsCreate });

    const req = createMockReq({ body: { orderId: CONSUMED_ORDER_BASE.order_id, payment_token: "some-valid-token" } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.url).toBe("https://stripe.invalid/pay/cs_test_mock_123");
    expect(stripeSessionsCreate).toHaveBeenCalledTimes(1);

    const callArgs = stripeSessionsCreate.mock.calls[0][0];
    expect(callArgs.line_items[0].price_data.unit_amount).toBe(50000); // 500 RMB * 100
    expect(callArgs.success_url).toContain(`step=5&order_id=${CONSUMED_ORDER_BASE.order_id}`);
    expect(callArgs.cancel_url).toContain(`step=4&order_id=${CONSUMED_ORDER_BASE.order_id}`);

    // 成功写回 pending + stripe_session_id
    const updatePayload = supabase.__tableCalls.orders.update.mock.calls[0][0];
    expect(updatePayload.payment_status).toBe("pending");
    expect(updatePayload.stripe_session_id).toBe("cs_test_mock_123");
  });

  test("授权恰好被消费一次（RPC 只调用一次），即使库存检查在消费之后才失败", async () => {
    const stripeSessionsCreate = jest.fn();
    const supabase = mockSupabaseFor({
      rpcResult: { data: [validConsumedRow()], error: null },
      inventoryRows: [row("2026-08-02", 0)],
    });
    const { handler } = loadHandler({ supabase, stripeSessionsCreate });

    const req = createMockReq({ body: { orderId: CONSUMED_ORDER_BASE.order_id, payment_token: "some-token" } });
    const res = createMockRes();
    await handler(req, res);

    expect(supabase.__calls.rpc.length).toBe(1);
    expect(supabase.__calls.rpc[0].name).toBe("consume_payment_authorization_v1");
  });

  test("Stripe 创建失败 -> 500 payment_session_failed；授权 RPC 已经调用过一次，本次请求不会重试/不会恢复 Token", async () => {
    const stripeSessionsCreate = jest.fn(() => Promise.reject(new Error("stripe down")));
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null } });
    const { handler } = loadHandler({ supabase, stripeSessionsCreate });

    const req = createMockReq({ body: { orderId: CONSUMED_ORDER_BASE.order_id, payment_token: "some-token" } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("payment_session_failed");
    expect(supabase.__calls.rpc.length).toBe(1); // 消费只发生一次，失败后不重试
    // Stripe 失败，从未走到写回一步——.from("orders") 的写回调用根本没发生过
    expect(supabase.__calls.from.filter((t) => t === "orders").length).toBe(0);
  });
});
