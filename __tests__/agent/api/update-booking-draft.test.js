const { createMockSupabase } = require("../../helpers/mockSupabase");
const { createMockRes } = require("../../helpers/mockReqRes");
const { TEST_AGENT_SERVICE_KEY, TEST_AGENT_BOOKING_TOKEN_SECRET } = require("../helpers/testSecrets");
const { computeSummaryHash } = require("../../../lib/agent/bookingSummary");

function loadHandler(supabase) {
  let handler;
  jest.isolateModules(() => {
    jest.doMock("@supabase/supabase-js", () => ({ createClient: jest.fn(() => supabase) }));
    const mod = require("../../../pages/api/agent/update-booking-draft");
    handler = mod.default || mod;
  });
  return handler;
}

const CAR = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";
const AUTH_HEADER = `Bearer ${TEST_AGENT_SERVICE_KEY}`;

const CURRENT_ORDER = {
  order_id: "ORD-20990901-33333",
  payment_status: "draft",
  start_date: "2099-09-01",
  end_date: "2099-09-01",
  car_model_id: CAR,
  driver_lang: "ZH",
  duration: 8,
  pax: 2,
  luggage: 1,
  departure_hotel: "Hotel A",
  end_hotel: "Hotel B",
  name: "Zhang San",
  phone: "13800000000",
  email: "zhangsan@example.com",
  wechat: null,
  itinerary: null,
  remark: null,
  total_price: 1600,
  deposit_amount: 500,
};

const CURRENT_HASH = computeSummaryHash(CURRENT_ORDER);

function issueToken(order_id) {
  const { issueBookingAccessToken } = require("../../../lib/agent/tokens/bookingAccessToken");
  return issueBookingAccessToken({ order_id }).token;
}

describe("pages/api/agent/update-booking-draft", () => {
  beforeEach(() => {
    process.env.AGENT_SERVICE_KEY = TEST_AGENT_SERVICE_KEY;
    process.env.AGENT_BOOKING_TOKEN_SECRET = TEST_AGENT_BOOKING_TOKEN_SECRET;
  });
  afterEach(() => {
    delete process.env.AGENT_SERVICE_KEY;
    delete process.env.AGENT_BOOKING_TOKEN_SECRET;
  });

  test("missing service auth -> 401, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: CURRENT_ORDER, error: null } } });
    const handler = loadHandler(supabase);
    const req = { method: "POST", headers: {}, body: { order_id: CURRENT_ORDER.order_id, expected_summary_hash: CURRENT_HASH, changes: {} } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("missing booking_access_token -> 401 booking_access_invalid, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: CURRENT_ORDER, error: null } } });
    const handler = loadHandler(supabase);
    const req = { method: "POST", headers: { authorization: AUTH_HEADER }, body: { order_id: CURRENT_ORDER.order_id, expected_summary_hash: CURRENT_HASH, changes: {} } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("booking_access_invalid");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("token issued for a DIFFERENT order_id -> booking_access_order_mismatch, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: CURRENT_ORDER, error: null } } });
    const handler = loadHandler(supabase);
    const token = issueToken("ORD-OTHER");
    const req = {
      method: "POST",
      headers: { authorization: AUTH_HEADER, "x-booking-access-token": token },
      body: { order_id: CURRENT_ORDER.order_id, expected_summary_hash: CURRENT_HASH, changes: {} },
    };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("booking_access_order_mismatch");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("expired token -> booking_access_expired, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: CURRENT_ORDER, error: null } } });
    const handler = loadHandler(supabase);
    const { issueBookingAccessToken } = require("../../../lib/agent/tokens/bookingAccessToken");
    const token = issueBookingAccessToken({ order_id: CURRENT_ORDER.order_id, ttlMs: -1000 }).token;
    const req = {
      method: "POST",
      headers: { authorization: AUTH_HEADER, "x-booking-access-token": token },
      body: { order_id: CURRENT_ORDER.order_id, expected_summary_hash: CURRENT_HASH, changes: {} },
    };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("booking_access_expired");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("stale expected_summary_hash -> 409, not updated", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: CURRENT_ORDER, error: null } } });
    const handler = loadHandler(supabase);
    const token = issueToken(CURRENT_ORDER.order_id);
    const req = {
      method: "POST",
      headers: { authorization: AUTH_HEADER, "x-booking-access-token": token },
      body: { order_id: CURRENT_ORDER.order_id, expected_summary_hash: "stale", changes: { remark: "x" } },
    };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("summary_stale");
  });

  test("valid request -> 200, updated summary with cleared confirmation and no PII", async () => {
    const supabase = createMockSupabase({
      from: {
        inventory_rules_v2: { data: [{ date: "2099-09-01", remaining_qty_calc: 3 }], error: null },
        orders: [
          { data: CURRENT_ORDER, error: null },
          {
            data: [
              {
                order_id: CURRENT_ORDER.order_id,
                start_date: CURRENT_ORDER.start_date,
                end_date: CURRENT_ORDER.end_date,
                car_model_id: CURRENT_ORDER.car_model_id,
                driver_lang: CURRENT_ORDER.driver_lang,
                duration: CURRENT_ORDER.duration,
                pax: CURRENT_ORDER.pax,
                luggage: CURRENT_ORDER.luggage,
                departure_hotel: CURRENT_ORDER.departure_hotel,
                end_hotel: "Hotel Z",
                total_price: 1600,
                deposit_amount: 500,
                payment_status: "draft",
                inventory_status: "pending",
              },
            ],
            error: null,
          },
        ],
      },
      rpc: () => ({ data: 1600, error: null }),
    });
    const handler = loadHandler(supabase);
    const token = issueToken(CURRENT_ORDER.order_id);
    const req = {
      method: "POST",
      headers: { authorization: AUTH_HEADER, "x-booking-access-token": token },
      body: { order_id: CURRENT_ORDER.order_id, expected_summary_hash: CURRENT_HASH, changes: { end_hotel: "Hotel Z" } },
    };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.updated).toBe(true);
    expect(res.body.confirmed).toBe(false);
    expect(res.body.end_hotel).toBe("Hotel Z");
    expect(res.body).not.toHaveProperty("name");
    expect(res.body).not.toHaveProperty("email");
  });
});
