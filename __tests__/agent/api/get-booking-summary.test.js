const { createMockSupabase } = require("../../helpers/mockSupabase");
const { createMockRes } = require("../../helpers/mockReqRes");
const { issueBookingAccessToken } = require("../../../lib/agent/tokens/bookingAccessToken");

function loadHandler(supabase) {
  let handler;
  jest.isolateModules(() => {
    jest.doMock("@supabase/supabase-js", () => ({ createClient: jest.fn(() => supabase) }));
    const mod = require("../../../pages/api/agent/get-booking-summary");
    handler = mod.default || mod;
  });
  return handler;
}

const ORDER_ROW = {
  order_id: "ORD-20260901-11111",
  start_date: "2026-09-01",
  end_date: "2026-09-01",
  car_model_id: "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca",
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

describe("pages/api/agent/get-booking-summary — two-layer auth", () => {
  beforeEach(() => {
    process.env.AGENT_SERVICE_KEY = "test-service-key-0123456789abcdef";
    process.env.AGENT_BOOKING_TOKEN_SECRET = "test-hmac-secret-0123456789abcdef";
  });
  afterEach(() => {
    delete process.env.AGENT_SERVICE_KEY;
    delete process.env.AGENT_BOOKING_TOKEN_SECRET;
  });

  test("layer 1 (service auth) checked and fails BEFORE layer 2 (booking token) is ever inspected", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: ORDER_ROW, error: null } } });
    const handler = loadHandler(supabase);
    const req = {
      method: "POST",
      headers: {}, // no Authorization at all
      body: { order_id: ORDER_ROW.order_id },
    };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("agent_unauthorized");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("layer 1 passes, layer 2 (booking token) missing -> booking_access_invalid, no DB read", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: ORDER_ROW, error: null } } });
    const handler = loadHandler(supabase);
    const req = {
      method: "POST",
      headers: { authorization: "Bearer test-service-key-0123456789abcdef" },
      body: { order_id: ORDER_ROW.order_id },
    };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("booking_access_invalid");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("both layers pass -> 200 with the summary whitelist + summary_hash", async () => {
    const issued = issueBookingAccessToken({ order_id: ORDER_ROW.order_id });
    const supabase = createMockSupabase({ from: { orders: { data: ORDER_ROW, error: null } } });
    const handler = loadHandler(supabase);
    const req = {
      method: "POST",
      headers: { authorization: "Bearer test-service-key-0123456789abcdef", "x-booking-access-token": issued.token },
      body: { order_id: ORDER_ROW.order_id },
    };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.order_id).toBe(ORDER_ROW.order_id);
    expect(typeof res.body.summary_hash).toBe("string");
    expect(res.body).not.toHaveProperty("name");
    expect(res.body).not.toHaveProperty("phone");
    expect(res.body).not.toHaveProperty("email");
  });

  test("token issued for a DIFFERENT order_id -> booking_access_order_mismatch, no DB read", async () => {
    const issued = issueBookingAccessToken({ order_id: "ORD-OTHER" });
    const supabase = createMockSupabase({ from: { orders: { data: ORDER_ROW, error: null } } });
    const handler = loadHandler(supabase);
    const req = {
      method: "POST",
      headers: { authorization: "Bearer test-service-key-0123456789abcdef", "x-booking-access-token": issued.token },
      body: { order_id: ORDER_ROW.order_id },
    };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("booking_access_order_mismatch");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("expired token -> booking_access_expired", async () => {
    const issued = issueBookingAccessToken({ order_id: ORDER_ROW.order_id, ttlMs: -1000 });
    const supabase = createMockSupabase({ from: { orders: { data: ORDER_ROW, error: null } } });
    const handler = loadHandler(supabase);
    const req = {
      method: "POST",
      headers: { authorization: "Bearer test-service-key-0123456789abcdef", "x-booking-access-token": issued.token },
      body: { order_id: ORDER_ROW.order_id },
    };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("booking_access_expired");
  });

  test("order_id is read from the POST body, never from a query string", async () => {
    const issued = issueBookingAccessToken({ order_id: ORDER_ROW.order_id });
    const supabase = createMockSupabase({ from: { orders: { data: ORDER_ROW, error: null } } });
    const handler = loadHandler(supabase);
    const req = {
      method: "POST",
      headers: { authorization: "Bearer test-service-key-0123456789abcdef", "x-booking-access-token": issued.token },
      query: { order_id: "ORD-FROM-QUERY-STRING-SHOULD-BE-IGNORED" },
      body: { order_id: ORDER_ROW.order_id },
    };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.order_id).toBe(ORDER_ROW.order_id);
  });
});
