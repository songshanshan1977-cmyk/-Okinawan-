const { createMockSupabase } = require("../../helpers/mockSupabase");
const { createMockRes } = require("../../helpers/mockReqRes");

function loadHandler(supabase) {
  let handler;
  jest.isolateModules(() => {
    jest.doMock("@supabase/supabase-js", () => ({ createClient: jest.fn(() => supabase) }));
    const mod = require("../../../pages/api/agent/create-booking-draft");
    handler = mod.default || mod;
  });
  return handler;
}

const CAR = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";

const VALID_BODY = {
  car_model_id: CAR,
  driver_lang: "zh",
  duration: 8,
  start_date: "2026-09-01",
  end_date: "2026-09-01",
  departure_hotel: "Hotel A",
  end_hotel: "Hotel B",
  pax: 2,
  luggage: 1,
  name: "Zhang San",
  phone: "13800000000",
  email: "zhangsan@example.com",
};

describe("pages/api/agent/create-booking-draft", () => {
  beforeEach(() => {
    process.env.AGENT_SERVICE_KEY = "test-service-key";
    process.env.AGENT_BOOKING_TOKEN_SECRET = "test-hmac-secret";
  });
  afterEach(() => {
    delete process.env.AGENT_SERVICE_KEY;
    delete process.env.AGENT_BOOKING_TOKEN_SECRET;
  });

  test("missing service auth -> 401, no database call at all", async () => {
    const supabase = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });
    const handler = loadHandler(supabase);
    const req = { method: "POST", headers: {}, body: VALID_BODY };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("success -> 200, output includes booking_access_token and never echoes injected total_price", async () => {
    const supabase = createMockSupabase({
      from: {
        inventory_rules_v2: { data: [{ date: "2026-09-01", remaining_qty_calc: 2 }], error: null },
        orders: { data: { order_id: "ORD-20260901-99999", payment_status: "draft", inventory_status: "pending", total_price: 1600, deposit_amount: 500 }, error: null },
      },
      rpc: () => ({ data: 1600, error: null }),
    });
    const handler = loadHandler(supabase);
    const req = {
      method: "POST",
      headers: { authorization: "Bearer test-service-key" },
      body: { ...VALID_BODY, total_price: 1, deposit_amount: 1 },
    };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.total_price).toBe(1600);
    expect(res.body.deposit_amount).toBe(500);
    expect(typeof res.body.booking_access_token).toBe("string");
  });

  test("inventory unavailable -> 409 inventory_unavailable", async () => {
    const supabase = createMockSupabase({
      from: { inventory_rules_v2: { data: [{ date: "2026-09-01", remaining_qty_calc: 0 }], error: null }, orders: { data: null, error: null } },
      rpc: () => ({ data: 1600, error: null }),
    });
    const handler = loadHandler(supabase);
    const req = { method: "POST", headers: { authorization: "Bearer test-service-key" }, body: VALID_BODY };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("inventory_unavailable");
  });
});
