const { createMockSupabase } = require("../../helpers/mockSupabase");
const { createMockRes } = require("../../helpers/mockReqRes");
const { TEST_AGENT_SERVICE_KEY, TEST_AGENT_BOOKING_TOKEN_SECRET } = require("../helpers/testSecrets");
const { computeSummaryHash } = require("../../../lib/agent/bookingSummary");

function loadHandler(supabase, stripeSessionsCreate) {
  let handler;
  const stripeConstructor = jest.fn(() => ({ checkout: { sessions: { create: stripeSessionsCreate } } }));
  jest.isolateModules(() => {
    jest.doMock("@supabase/supabase-js", () => ({ createClient: jest.fn(() => supabase) }));
    jest.doMock("stripe", () => stripeConstructor);
    const mod = require("../../../pages/api/agent/create-payment-link");
    handler = mod.default || mod;
  });
  return handler;
}

const CAR = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";
const AUTH_HEADER = `Bearer ${TEST_AGENT_SERVICE_KEY}`;

const ORDER_CONTENT = {
  order_id: "ORD-20990901-66666",
  start_date: "2099-09-01",
  end_date: "2099-09-01",
  car_model_id: CAR,
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
const LIVE_HASH = computeSummaryHash(ORDER_CONTENT);

function orderRow(confirmed) {
  return {
    ...ORDER_CONTENT,
    agent_summary_confirmed_hash: confirmed ? LIVE_HASH : null,
    agent_summary_confirmed_at: confirmed ? "2099-01-01T00:00:00.000Z" : null,
  };
}

function consumedRowFor(order) {
  return {
    ...order,
    payment_authorization_summary_hash: computeSummaryHash(order),
    payment_authorization_deposit_amount: 500,
    payment_attempt_id: "attempt-id-fixed-for-tests",
    stripe_session_id: null,
  };
}

function issueToken(order_id) {
  const { issueBookingAccessToken } = require("../../../lib/agent/tokens/bookingAccessToken");
  return issueBookingAccessToken({ order_id }).token;
}

describe("pages/api/agent/create-payment-link", () => {
  beforeEach(() => {
    process.env.AGENT_SERVICE_KEY = TEST_AGENT_SERVICE_KEY;
    process.env.AGENT_BOOKING_TOKEN_SECRET = TEST_AGENT_BOOKING_TOKEN_SECRET;
    process.env.NEXT_PUBLIC_SITE_URL = "https://sandbox.invalid";
  });
  afterEach(() => {
    delete process.env.AGENT_SERVICE_KEY;
    delete process.env.AGENT_BOOKING_TOKEN_SECRET;
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  test("missing service auth -> 401, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: orderRow(true), error: null } } });
    const handler = loadHandler(supabase, jest.fn());
    const req = { method: "POST", headers: {}, body: { order_id: ORDER_CONTENT.order_id } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("missing booking_access_token -> 401 booking_access_invalid, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: orderRow(true), error: null } } });
    const handler = loadHandler(supabase, jest.fn());
    const req = { method: "POST", headers: { authorization: AUTH_HEADER }, body: { order_id: ORDER_CONTENT.order_id } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("booking_access_invalid");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("token/order_id mismatch -> booking_access_order_mismatch, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: orderRow(true), error: null } } });
    const handler = loadHandler(supabase, jest.fn());
    const token = issueToken("ORD-OTHER");
    const req = { method: "POST", headers: { authorization: AUTH_HEADER, "x-booking-access-token": token }, body: { order_id: ORDER_CONTENT.order_id } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("booking_access_order_mismatch");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("not confirmed -> 409 summary_not_confirmed, zero Stripe calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: orderRow(false), error: null } } });
    const stripeSessionsCreate = jest.fn();
    const handler = loadHandler(supabase, stripeSessionsCreate);
    const token = issueToken(ORDER_CONTENT.order_id);
    const req = { method: "POST", headers: { authorization: AUTH_HEADER, "x-booking-access-token": token }, body: { order_id: ORDER_CONTENT.order_id } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("summary_not_confirmed");
    expect(stripeSessionsCreate).not.toHaveBeenCalled();
  });

  test("confirmed and current -> 200, ok, pending, url, no PII/token/hash leaked", async () => {
    const row = orderRow(true);
    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: row, error: null }, // lookup
          { data: [{ order_id: row.order_id, stripe_session_id: "cs_api_1", payment_status: "pending" }], error: null }, // createCheckoutSession write-back
        ],
        inventory_rules_v2: { data: [{ date: "2099-09-01", remaining_qty_calc: 3 }], error: null },
      },
      rpc: (name, args) => {
        if (name === "issue_payment_authorization_v1") return { data: [{ order_id: args.p_order_id, payment_attempt_id: "attempt-id-fixed-for-tests" }], error: null };
        if (name === "consume_payment_authorization_v1") return { data: [consumedRowFor(row)], error: null };
        return { data: null, error: { message: "unknown rpc" } };
      },
    });
    const stripeSessionsCreate = jest.fn(() => Promise.resolve({ id: "cs_api_1", url: "https://stripe.invalid/pay/cs_api_1" }));
    const handler = loadHandler(supabase, stripeSessionsCreate);
    const token = issueToken(ORDER_CONTENT.order_id);
    const req = { method: "POST", headers: { authorization: AUTH_HEADER, "x-booking-access-token": token }, body: { order_id: ORDER_CONTENT.order_id } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.payment_status).toBe("pending");
    expect(res.body.url).toBe("https://stripe.invalid/pay/cs_api_1");
    expect(Object.keys(res.body).sort()).toEqual(["ok", "order_id", "payment_status", "url", "expires_at"].sort());
  });

  test("A3 revision: pending order (existing payment attempt) is still attemptable -> 200", async () => {
    const row = { ...orderRow(true), payment_status: "pending" };
    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: row, error: null },
          { data: [{ order_id: row.order_id, stripe_session_id: "cs_api_pending_1", payment_status: "pending" }], error: null },
        ],
        inventory_rules_v2: { data: [{ date: "2099-09-01", remaining_qty_calc: 3 }], error: null },
      },
      rpc: (name, args) => {
        if (name === "issue_payment_authorization_v1") return { data: [{ order_id: args.p_order_id, payment_attempt_id: "attempt-id-fixed-for-tests" }], error: null };
        if (name === "consume_payment_authorization_v1") return { data: [consumedRowFor(row)], error: null };
        return { data: null, error: { message: "unknown rpc" } };
      },
    });
    const stripeSessionsCreate = jest.fn(() => Promise.resolve({ id: "cs_api_pending_1", url: "https://stripe.invalid/pay/cs_api_pending_1" }));
    const handler = loadHandler(supabase, stripeSessionsCreate);
    const token = issueToken(ORDER_CONTENT.order_id);
    const req = { method: "POST", headers: { authorization: AUTH_HEADER, "x-booking-access-token": token }, body: { order_id: ORDER_CONTENT.order_id } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("already-paid order -> 409 paid_order_immutable", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: { ...orderRow(true), payment_status: "paid" }, error: null } } });
    const handler = loadHandler(supabase, jest.fn());
    const token = issueToken(ORDER_CONTENT.order_id);
    const req = { method: "POST", headers: { authorization: AUTH_HEADER, "x-booking-access-token": token }, body: { order_id: ORDER_CONTENT.order_id } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("paid_order_immutable");
  });
});
