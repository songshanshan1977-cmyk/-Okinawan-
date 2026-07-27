const { createMockSupabase } = require("../../helpers/mockSupabase");
const { createMockRes } = require("../../helpers/mockReqRes");
const { TEST_AGENT_SERVICE_KEY, TEST_AGENT_BOOKING_TOKEN_SECRET } = require("../helpers/testSecrets");
const { computeFieldsHash } = require("../../../lib/agent/hashUtils");
const { IDEMPOTENCY_REQUEST_FIELDS, normalizeForIdempotencyHash } = require("../../../lib/agent/tools/createBookingDraft");

function loadHandler(supabase) {
  let handler;
  jest.isolateModules(() => {
    jest.doMock("@supabase/supabase-js", () => ({ createClient: jest.fn(() => supabase) }));
    const mod = require("../../../pages/api/agent/create-booking-draft");
    handler = mod.default || mod;
  });
  return handler;
}

function requestHashFor(body) {
  return computeFieldsHash(IDEMPOTENCY_REQUEST_FIELDS, normalizeForIdempotencyHash(body));
}

const CAR = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";
const AUTH_HEADER = `Bearer ${TEST_AGENT_SERVICE_KEY}`;

const VALID_BODY = {
  car_model_id: CAR,
  driver_lang: "zh",
  duration: 8,
  start_date: "2099-09-01",
  end_date: "2099-09-01",
  departure_hotel: "Hotel A",
  end_hotel: "Hotel B",
  pax: 2,
  luggage: 1,
  name: "Zhang San",
  phone: "13800000000",
  email: "zhangsan@example.com",
};

const NOT_FOUND = { data: null, error: null };
const INSERTED_ORDER = { order_id: "ORD-20990901-99999", payment_status: "draft", inventory_status: "pending", total_price: 1600, deposit_amount: 500 };

describe("pages/api/agent/create-booking-draft", () => {
  beforeEach(() => {
    process.env.AGENT_SERVICE_KEY = TEST_AGENT_SERVICE_KEY;
    process.env.AGENT_BOOKING_TOKEN_SECRET = TEST_AGENT_BOOKING_TOKEN_SECRET;
  });
  afterEach(() => {
    delete process.env.AGENT_SERVICE_KEY;
    delete process.env.AGENT_BOOKING_TOKEN_SECRET;
  });

  test("missing service auth -> 401, no database call at all", async () => {
    const supabase = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });
    const handler = loadHandler(supabase);
    const req = { method: "POST", headers: { "idempotency-key": "key-1" }, body: VALID_BODY };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("missing Idempotency-Key header -> 400 invalid_request, no database call", async () => {
    const supabase = createMockSupabase({
      from: { inventory_rules_v2: { data: [{ date: "2099-09-01", remaining_qty_calc: 2 }], error: null }, orders: { data: [INSERTED_ORDER], error: null } },
      rpc: () => ({ data: 1600, error: null }),
    });
    const handler = loadHandler(supabase);
    const req = { method: "POST", headers: { authorization: AUTH_HEADER }, body: VALID_BODY };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("brand-new key -> 200, output includes booking_access_token and never echoes injected total_price", async () => {
    const supabase = createMockSupabase({
      from: {
        inventory_rules_v2: { data: [{ date: "2099-09-01", remaining_qty_calc: 2 }], error: null },
        orders: [NOT_FOUND, { data: [INSERTED_ORDER], error: null }],
      },
      rpc: () => ({ data: 1600, error: null }),
    });
    const handler = loadHandler(supabase);
    const req = {
      method: "POST",
      headers: { authorization: AUTH_HEADER, "idempotency-key": "order-attempt-1" },
      body: { ...VALID_BODY, total_price: 1, deposit_amount: 1 },
    };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.total_price).toBe(1600);
    expect(res.body.deposit_amount).toBe(500);
    expect(typeof res.body.booking_access_token).toBe("string");
  });

  test("existing_order_id in the body -> 400 invalid_request, no database call (A1-B01)", async () => {
    const supabase = createMockSupabase({
      from: { inventory_rules_v2: { data: [{ date: "2099-09-01", remaining_qty_calc: 2 }], error: null }, orders: { data: [INSERTED_ORDER], error: null } },
      rpc: () => ({ data: 1600, error: null }),
    });
    const handler = loadHandler(supabase);
    const req = {
      method: "POST",
      headers: { authorization: AUTH_HEADER, "idempotency-key": "key-1" },
      body: { ...VALID_BODY, existing_order_id: "ORD-SOMETHING" },
    };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("inventory unavailable -> 409 inventory_unavailable", async () => {
    const supabase = createMockSupabase({
      from: {
        inventory_rules_v2: { data: [{ date: "2099-09-01", remaining_qty_calc: 0 }], error: null },
        orders: [NOT_FOUND, { data: [INSERTED_ORDER], error: null }],
      },
      rpc: () => ({ data: 1600, error: null }),
    });
    const handler = loadHandler(supabase);
    const req = { method: "POST", headers: { authorization: AUTH_HEADER, "idempotency-key": "key-1" }, body: VALID_BODY };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("inventory_unavailable");
  });

  test("same Idempotency-Key + same body replayed -> 200 with the SAME order_id via the fast pre-check path, no price/availability re-run", async () => {
    const existingRow = { ...INSERTED_ORDER, agent_idempotency_request_hash: requestHashFor(VALID_BODY) };

    const supabase = createMockSupabase({
      from: { orders: { data: existingRow, error: null } }, // only the pre-check SELECT — no inventory_rules_v2 fixture needed at all
      rpc: () => ({ data: 1600, error: null }),
    });
    const handler = loadHandler(supabase);
    const req = { method: "POST", headers: { authorization: AUTH_HEADER, "idempotency-key": "replayed-key" }, body: VALID_BODY };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.order_id).toBe(existingRow.order_id);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test("same Idempotency-Key + DIFFERENT body -> 409 idempotency_conflict, resolved entirely by the pre-check", async () => {
    const existingRow = { ...INSERTED_ORDER, agent_idempotency_request_hash: "some-other-request-hash" };

    const supabase = createMockSupabase({
      from: { orders: { data: existingRow, error: null } },
      rpc: () => ({ data: 1600, error: null }),
    });
    const handler = loadHandler(supabase);
    const req = { method: "POST", headers: { authorization: AUTH_HEADER, "idempotency-key": "reused-key-different-body" }, body: VALID_BODY };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("idempotency_conflict");
  });
});
