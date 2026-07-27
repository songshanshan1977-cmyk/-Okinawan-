const { createMockSupabase } = require("../../helpers/mockSupabase");
const { createMockRes } = require("../../helpers/mockReqRes");
const { TEST_AGENT_SERVICE_KEY, TEST_AGENT_BOOKING_TOKEN_SECRET } = require("../helpers/testSecrets");
const { computeSummaryHash } = require("../../../lib/agent/bookingSummary");

function loadHandler(supabase) {
  let handler;
  jest.isolateModules(() => {
    jest.doMock("@supabase/supabase-js", () => ({ createClient: jest.fn(() => supabase) }));
    const mod = require("../../../pages/api/agent/confirm-booking-summary");
    handler = mod.default || mod;
  });
  return handler;
}

const CAR = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";
const AUTH_HEADER = `Bearer ${TEST_AGENT_SERVICE_KEY}`;

const ORDER_ROW = {
  order_id: "ORD-20990901-44444",
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
  agent_summary_confirmed_hash: null,
  agent_summary_confirmed_at: null,
};

const CURRENT_HASH = computeSummaryHash(ORDER_ROW);

function issueToken(order_id) {
  const { issueBookingAccessToken } = require("../../../lib/agent/tokens/bookingAccessToken");
  return issueBookingAccessToken({ order_id }).token;
}

describe("pages/api/agent/confirm-booking-summary", () => {
  beforeEach(() => {
    process.env.AGENT_SERVICE_KEY = TEST_AGENT_SERVICE_KEY;
    process.env.AGENT_BOOKING_TOKEN_SECRET = TEST_AGENT_BOOKING_TOKEN_SECRET;
  });
  afterEach(() => {
    delete process.env.AGENT_SERVICE_KEY;
    delete process.env.AGENT_BOOKING_TOKEN_SECRET;
  });

  test("missing service auth -> 401, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: ORDER_ROW, error: null } } });
    const handler = loadHandler(supabase);
    const req = { method: "POST", headers: {}, body: { order_id: ORDER_ROW.order_id, summary_hash: CURRENT_HASH } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("missing booking_access_token -> 401 booking_access_invalid, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: ORDER_ROW, error: null } } });
    const handler = loadHandler(supabase);
    const req = { method: "POST", headers: { authorization: AUTH_HEADER }, body: { order_id: ORDER_ROW.order_id, summary_hash: CURRENT_HASH } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("booking_access_invalid");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("token/order_id mismatch -> booking_access_order_mismatch, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: ORDER_ROW, error: null } } });
    const handler = loadHandler(supabase);
    const token = issueToken("ORD-OTHER");
    const req = { method: "POST", headers: { authorization: AUTH_HEADER, "x-booking-access-token": token }, body: { order_id: ORDER_ROW.order_id, summary_hash: CURRENT_HASH } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("booking_access_order_mismatch");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("stale hash -> 409 summary_stale", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: ORDER_ROW, error: null } } });
    const handler = loadHandler(supabase);
    const token = issueToken(ORDER_ROW.order_id);
    const req = { method: "POST", headers: { authorization: AUTH_HEADER, "x-booking-access-token": token }, body: { order_id: ORDER_ROW.order_id, summary_hash: "stale" } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("summary_stale");
  });

  test("current hash -> 200, persisted, no PII, no price/content change", async () => {
    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: ORDER_ROW, error: null },
          { data: [{ agent_summary_confirmed_hash: CURRENT_HASH, agent_summary_confirmed_at: "2099-09-01T00:00:00.000Z" }], error: null },
        ],
      },
    });
    const handler = loadHandler(supabase);
    const token = issueToken(ORDER_ROW.order_id);
    const req = { method: "POST", headers: { authorization: AUTH_HEADER, "x-booking-access-token": token }, body: { order_id: ORDER_ROW.order_id, summary_hash: CURRENT_HASH } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.confirmed).toBe(true);
    expect(res.body.summary_hash).toBe(CURRENT_HASH);
    expect(typeof res.body.confirmed_at).toBe("string");
    expect(Object.keys(res.body).sort()).toEqual(["ok", "confirmed", "order_id", "summary_hash", "confirmed_at"].sort());
  });

  test("already-paid order -> 409 paid_order_immutable", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: { ...ORDER_ROW, payment_status: "paid" }, error: null } } });
    const handler = loadHandler(supabase);
    const token = issueToken(ORDER_ROW.order_id);
    const req = { method: "POST", headers: { authorization: AUTH_HEADER, "x-booking-access-token": token }, body: { order_id: ORDER_ROW.order_id, summary_hash: CURRENT_HASH } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("paid_order_immutable");
  });
});
