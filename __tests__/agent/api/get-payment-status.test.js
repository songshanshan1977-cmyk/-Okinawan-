const { createMockSupabase } = require("../../helpers/mockSupabase");
const { createMockRes } = require("../../helpers/mockReqRes");
const { TEST_AGENT_SERVICE_KEY, TEST_AGENT_BOOKING_TOKEN_SECRET } = require("../helpers/testSecrets");

function loadHandler(supabase) {
  let handler;
  jest.isolateModules(() => {
    jest.doMock("@supabase/supabase-js", () => ({ createClient: jest.fn(() => supabase) }));
    const mod = require("../../../pages/api/agent/get-payment-status");
    handler = mod.default || mod;
  });
  return handler;
}

const ORDER_ID = "ORD-20990901-33333";
const AUTH_HEADER = `Bearer ${TEST_AGENT_SERVICE_KEY}`;

function issueToken(order_id) {
  const { issueBookingAccessToken } = require("../../../lib/agent/tokens/bookingAccessToken");
  return issueBookingAccessToken({ order_id }).token;
}

describe("pages/api/agent/get-payment-status", () => {
  beforeEach(() => {
    process.env.AGENT_SERVICE_KEY = TEST_AGENT_SERVICE_KEY;
    process.env.AGENT_BOOKING_TOKEN_SECRET = TEST_AGENT_BOOKING_TOKEN_SECRET;
  });
  afterEach(() => {
    delete process.env.AGENT_SERVICE_KEY;
    delete process.env.AGENT_BOOKING_TOKEN_SECRET;
  });

  test("missing service auth -> 401, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: { order_id: ORDER_ID, payment_status: "paid", inventory_status: "confirmed", inventory_locked: true }, error: null } } });
    const handler = loadHandler(supabase);
    const req = { method: "POST", headers: {}, body: { order_id: ORDER_ID } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("missing booking_access_token -> 401 booking_access_invalid, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: { order_id: ORDER_ID, payment_status: "paid", inventory_status: "confirmed", inventory_locked: true }, error: null } } });
    const handler = loadHandler(supabase);
    const req = { method: "POST", headers: { authorization: AUTH_HEADER }, body: { order_id: ORDER_ID } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("booking_access_invalid");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("token/order_id mismatch -> booking_access_order_mismatch, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: { order_id: ORDER_ID, payment_status: "paid", inventory_status: "confirmed", inventory_locked: true }, error: null } } });
    const handler = loadHandler(supabase);
    const token = issueToken("ORD-OTHER");
    const req = { method: "POST", headers: { authorization: AUTH_HEADER, "x-booking-access-token": token }, body: { order_id: ORDER_ID } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("booking_access_order_mismatch");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("paid order -> 200, paid:true, no PII", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: { order_id: ORDER_ID, payment_status: "paid", inventory_status: "confirmed", inventory_locked: true, name: "Zhang San" }, error: null } } });
    const handler = loadHandler(supabase);
    const token = issueToken(ORDER_ID);
    const req = { method: "POST", headers: { authorization: AUTH_HEADER, "x-booking-access-token": token }, body: { order_id: ORDER_ID } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.paid).toBe(true);
    expect(res.body.name).toBeUndefined();
    expect(Object.keys(res.body).sort()).toEqual(["ok", "order_id", "payment_status", "inventory_status", "inventory_locked", "paid"].sort());
  });

  test("order not found -> 404 order_not_found", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: null, error: null } } });
    const handler = loadHandler(supabase);
    const token = issueToken(ORDER_ID);
    const req = { method: "POST", headers: { authorization: AUTH_HEADER, "x-booking-access-token": token }, body: { order_id: ORDER_ID } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe("order_not_found");
  });
});
