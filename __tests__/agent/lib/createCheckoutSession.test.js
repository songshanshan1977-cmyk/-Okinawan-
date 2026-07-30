const { createCheckoutSession, RPC_NAME } = require("../../../lib/payment/createCheckoutSession");
const { computeSummaryHash } = require("../../../lib/agent/bookingSummary");
const { createMockSupabase } = require("../../helpers/mockSupabase");
const { AGENT_ERROR_CODES } = require("../../../lib/agent/errorCodes");

const CONSUMED_ORDER_BASE = {
  order_id: "ORD-20990901-88888",
  start_date: "2099-09-01",
  end_date: "2099-09-01",
  car_model_id: "car-x",
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

function validConsumedRow(overrides = {}) {
  return {
    ...CONSUMED_ORDER_BASE,
    payment_authorization_summary_hash: VALID_BOUND_HASH,
    payment_authorization_deposit_amount: 500,
    ...overrides,
  };
}

function fakeStripe(createImpl) {
  return { checkout: { sessions: { create: jest.fn(createImpl) } } };
}

const FULL_INVENTORY = [{ date: "2099-09-01", remaining_qty_calc: 3 }];
const SOLD_OUT_INVENTORY = [{ date: "2099-09-01", remaining_qty_calc: 0 }];

function mockSupabaseFor({ rpcResult, inventoryRows = FULL_INVENTORY, orderUpdateResult = { data: null, error: null } }) {
  return createMockSupabase({
    from: { orders: orderUpdateResult, inventory_rules_v2: { data: inventoryRows, error: null } },
    rpc: () => rpcResult,
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://sandbox.invalid";
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.SITE_URL;
});

describe("createCheckoutSession — input/env gates", () => {
  test("missing order_id -> invalid_request, zero rpc calls", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: undefined, payment_token: "t" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.__calls.rpc.length).toBe(0);
  });

  test("missing payment_token -> invalid_request, zero rpc calls", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: undefined });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.__calls.rpc.length).toBe(0);
  });

  test("SITE_URL not configured -> payment_session_failed, zero rpc calls", async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.SITE_URL;
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED);
    expect(supabase.__calls.rpc.length).toBe(0);
  });
});

describe("createCheckoutSession — atomic consumption via consume_payment_authorization_v1", () => {
  test("hashes the raw token before calling the RPC — the RPC never sees the raw token", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null } });
    const stripe = fakeStripe(() => Promise.resolve({ id: "cs_1", url: "https://stripe.invalid/1" }));
    await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "raw-secret-token" });

    const rpcCall = supabase.__calls.rpc[0];
    expect(rpcCall.name).toBe(RPC_NAME);
    expect(rpcCall.args.p_order_id).toBe(CONSUMED_ORDER_BASE.order_id);
    expect(rpcCall.args.p_token_hash).not.toBe("raw-secret-token");
    expect(rpcCall.args.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("RPC database error -> payment_session_failed, zero Stripe calls", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: null, error: { message: "db down" } } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test("RPC returns zero rows (no match: wrong order, wrong token, expired, or already consumed) -> payment_authorization_expired_or_used, zero Stripe calls", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [], error: null } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_AUTHORIZATION_EXPIRED_OR_USED);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test("RPC returns more than one row (shape anomaly) -> payment_session_failed, never guesses", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow(), validConsumedRow()], error: null } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("createCheckoutSession — post-consumption re-verification", () => {
  test("live summary_hash differs from the hash the authorization was bound to -> payment_summary_stale, zero Stripe calls", async () => {
    const staleRow = validConsumedRow({ duration: 10 }); // content changed after authorization was issued
    const supabase = mockSupabaseFor({ rpcResult: { data: [staleRow], error: null } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SUMMARY_STALE);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test("order's current deposit_amount no longer matches the bound authorization deposit -> payment_summary_stale", async () => {
    const row = validConsumedRow({ deposit_amount: 999, payment_authorization_deposit_amount: 500 });
    const supabase = mockSupabaseFor({ rpcResult: { data: [row], error: null } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SUMMARY_STALE);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test("bound deposit is not the fixed 500 -> payment_summary_stale", async () => {
    const row = validConsumedRow({ deposit_amount: 1, payment_authorization_deposit_amount: 1 });
    const supabase = mockSupabaseFor({ rpcResult: { data: [row], error: null } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SUMMARY_STALE);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test("inventory unavailable -> inventory_unavailable with unavailable_dates, zero Stripe calls", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null }, inventoryRows: SOLD_OUT_INVENTORY });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.code).toBe(AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE);
    expect(result.unavailable_dates).toEqual([{ date: "2099-09-01", reason: "sold_out" }]);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("createCheckoutSession — success path", () => {
  test("valid authorization -> exactly one Stripe call, fixed 500 RMB, writes back pending + session id", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null } });
    const stripe = fakeStripe(() => Promise.resolve({ id: "cs_ok_1", url: "https://stripe.invalid/pay/cs_ok_1" }));

    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });

    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://stripe.invalid/pay/cs_ok_1");
    expect(result.order_id).toBe(CONSUMED_ORDER_BASE.order_id);
    expect(result.payment_status).toBe("pending");

    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    const callArgs = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(callArgs.line_items[0].price_data.unit_amount).toBe(50000);
    expect(callArgs.line_items[0].price_data.currency).toBe("cny");
    expect(callArgs.success_url).toContain(`order_id=${CONSUMED_ORDER_BASE.order_id}`);

    const updatePayload = supabase.__tableCalls.orders.update.mock.calls[0][0];
    expect(updatePayload.payment_status).toBe("pending");
    expect(updatePayload.stripe_session_id).toBe("cs_ok_1");
  });

  test("Stripe throws -> payment_session_failed; the authorization RPC ran exactly once and is NOT retried or restored", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null } });
    const stripe = fakeStripe(() => Promise.reject(new Error("stripe unreachable")));

    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED);
    expect(supabase.__calls.rpc.length).toBe(1);
    // Stripe threw before the write-back step, so .from("orders") for the
    // update was never even reached (not just "called with no effect").
    expect(supabase.__calls.from.filter((t) => t === "orders").length).toBe(0);
  });
});
