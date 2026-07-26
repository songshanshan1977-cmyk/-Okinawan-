const { createBookingDraftTool } = require("../../../lib/agent/tools/createBookingDraft");
const { createMockSupabase } = require("../../helpers/mockSupabase");
const { AGENT_ERROR_CODES } = require("../../../lib/agent/errorCodes");

const CAR = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";

const VALID_INPUT = {
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

const AVAILABLE_INVENTORY = { inventory_rules_v2: { data: [{ date: "2026-09-01", remaining_qty_calc: 3 }], error: null } };
const SOLD_OUT_INVENTORY = { inventory_rules_v2: { data: [{ date: "2026-09-01", remaining_qty_calc: 0 }], error: null } };

const INSERTED_ORDER_FIXTURE = {
  order_id: "ORD-20260901-54321",
  payment_status: "draft",
  inventory_status: "pending",
  total_price: 1600,
  deposit_amount: 500,
};

beforeEach(() => {
  process.env.AGENT_BOOKING_TOKEN_SECRET = "test-hmac-secret";
});

afterEach(() => {
  delete process.env.AGENT_BOOKING_TOKEN_SECRET;
});

describe("createBookingDraftTool", () => {
  test("brand-new draft: never trusts caller-supplied total_price/deposit_amount/payment_status/inventory_status/stripe_session_id", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: { data: INSERTED_ORDER_FIXTURE, error: null } },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({
      supabase,
      data: {
        ...VALID_INPUT,
        total_price: 1, // attacker-injected
        deposit_amount: 1, // attacker-injected
        payment_status: "paid", // attacker-injected
        inventory_status: "locked", // attacker-injected
        stripe_session_id: "cs_fake_injected", // attacker-injected
      },
    });

    expect(result.ok).toBe(true);
    expect(result.order_id).toBe(INSERTED_ORDER_FIXTURE.order_id);
    expect(result.total_price).toBe(1600); // server-recomputed, not the injected 1
    expect(result.deposit_amount).toBe(500); // fixed constant, not the injected 1

    const insertArgs = supabase.__tableCalls.orders.insert.mock.calls[0][0][0];
    expect(insertArgs.total_price).toBe(1600);
    expect(insertArgs.deposit_amount).toBe(500);
    expect(insertArgs.payment_status).toBe("draft"); // not "paid"
    expect(insertArgs.inventory_status).toBe("pending"); // not "locked"
    expect(insertArgs).not.toHaveProperty("stripe_session_id");
  });

  test("fixed source='agent' regardless of caller-supplied source", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: { data: INSERTED_ORDER_FIXTURE, error: null } },
      rpc: () => ({ data: 1600, error: null }),
    });

    await createBookingDraftTool({ supabase, data: { ...VALID_INPUT, source: "direct" } });

    const insertArgs = supabase.__tableCalls.orders.insert.mock.calls[0][0][0];
    expect(insertArgs.source).toBe("agent");
  });

  test("returns the database's final server-generated order_id, not any client-suggested id", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: { data: INSERTED_ORDER_FIXTURE, error: null } },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: { ...VALID_INPUT, order_id: "ORD-CLIENT-SUPPLIED" } });

    expect(result.order_id).toBe(INSERTED_ORDER_FIXTURE.order_id);
    expect(result.order_id).not.toBe("ORD-CLIENT-SUPPLIED");
    const insertArgs = supabase.__tableCalls.orders.insert.mock.calls[0][0][0];
    // insertNewDraftWithRetry always overwrites order_id with its own
    // server-generated candidate, even if content carried one through.
    expect(insertArgs.order_id).not.toBe("ORD-CLIENT-SUPPLIED");
  });

  test("issues a booking_access_token bound to the final order_id", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: { data: INSERTED_ORDER_FIXTURE, error: null } },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT });

    expect(typeof result.booking_access_token).toBe("string");
    const { verifyBookingAccessToken } = require("../../../lib/agent/tokens/bookingAccessToken");
    const verified = verifyBookingAccessToken({ token: result.booking_access_token, order_id: result.order_id });
    expect(verified.ok).toBe(true);
  });

  test("sold-out inventory -> inventory_unavailable, no draft inserted", async () => {
    const supabase = createMockSupabase({
      from: { ...SOLD_OUT_INVENTORY, orders: { data: INSERTED_ORDER_FIXTURE, error: null } },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE);
    expect(supabase.__tableCalls.orders).toBeUndefined();
  });

  test("missing required field -> invalid_request, no DB calls at all", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: { data: INSERTED_ORDER_FIXTURE, error: null } },
      rpc: () => ({ data: 1600, error: null }),
    });
    const { name, ...withoutName } = VALID_INPUT;

    const result = await createBookingDraftTool({ supabase, data: withoutName });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("AGENT_BOOKING_TOKEN_SECRET missing -> fails closed BEFORE any database write", async () => {
    delete process.env.AGENT_BOOKING_TOKEN_SECRET;
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: { data: INSERTED_ORDER_FIXTURE, error: null } },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  describe("existing_order_id path", () => {
    test("existing order already paid -> paid_order_immutable, no write", async () => {
      const paidExisting = { order_id: "ORD-EXIST-1", payment_status: "paid", ...VALID_INPUT };
      const supabase = createMockSupabase({
        from: { orders: { data: paidExisting, error: null } },
        rpc: () => ({ data: 1600, error: null }),
      });

      const result = await createBookingDraftTool({ supabase, data: { ...VALID_INPUT, existing_order_id: "ORD-EXIST-1" } });

      expect(result.ok).toBe(false);
      expect(result.code).toBe(AGENT_ERROR_CODES.PAID_ORDER_IMMUTABLE);
    });

    test("existing_order_id not found -> order_not_found", async () => {
      const supabase = createMockSupabase({ from: { orders: { data: null, error: null } }, rpc: () => ({ data: 1600, error: null }) });

      const result = await createBookingDraftTool({ supabase, data: { ...VALID_INPUT, existing_order_id: "ORD-NOPE" } });

      expect(result.ok).toBe(false);
      expect(result.code).toBe(AGENT_ERROR_CODES.ORDER_NOT_FOUND);
    });

    test("identical content -> reuse existing draft, zero writes, fresh token still issued", async () => {
      const existingDraft = {
        order_id: "ORD-EXIST-2",
        payment_status: "draft",
        inventory_status: "pending",
        car_model_id: VALID_INPUT.car_model_id,
        driver_lang: "ZH",
        duration: VALID_INPUT.duration,
        start_date: VALID_INPUT.start_date,
        end_date: VALID_INPUT.end_date,
        departure_hotel: VALID_INPUT.departure_hotel,
        end_hotel: VALID_INPUT.end_hotel,
        pax: VALID_INPUT.pax,
        luggage: VALID_INPUT.luggage,
        name: VALID_INPUT.name,
        phone: VALID_INPUT.phone,
        email: VALID_INPUT.email,
        wechat: null,
        itinerary: null,
        remark: null,
        total_price: 1600, // must equal RPC dailyPrice(1600) x 1 day for contentsEqual to hold
        deposit_amount: 500,
      };
      const supabase = createMockSupabase({ from: { orders: { data: existingDraft, error: null } }, rpc: () => ({ data: 1600, error: null }) });

      const result = await createBookingDraftTool({ supabase, data: { ...VALID_INPUT, existing_order_id: "ORD-EXIST-2" } });

      expect(result.ok).toBe(true);
      expect(result.order_id).toBe("ORD-EXIST-2");
      expect(result.created_new_order).toBe(false);
      expect(supabase.__tableCalls.orders.insert).not.toHaveBeenCalled();
      expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
      expect(typeof result.booking_access_token).toBe("string");
    });

    test("different content -> supersedes with a fresh server-generated order_id, old draft never mutated", async () => {
      const existingDraft = {
        order_id: "ORD-EXIST-3",
        payment_status: "draft",
        inventory_status: "pending",
        car_model_id: VALID_INPUT.car_model_id,
        driver_lang: "ZH",
        duration: VALID_INPUT.duration,
        start_date: "2026-10-01", // different date than VALID_INPUT
        end_date: "2026-10-01",
        departure_hotel: VALID_INPUT.departure_hotel,
        end_hotel: VALID_INPUT.end_hotel,
        pax: VALID_INPUT.pax,
        luggage: VALID_INPUT.luggage,
        name: VALID_INPUT.name,
        phone: VALID_INPUT.phone,
        email: VALID_INPUT.email,
        total_price: 1600,
        deposit_amount: 500,
      };
      const supabase = createMockSupabase({
        from: { orders: [{ data: existingDraft, error: null }, { data: INSERTED_ORDER_FIXTURE, error: null }], ...AVAILABLE_INVENTORY },
        rpc: () => ({ data: 1600, error: null }),
      });

      const result = await createBookingDraftTool({ supabase, data: { ...VALID_INPUT, existing_order_id: "ORD-EXIST-3" } });

      expect(result.ok).toBe(true);
      expect(result.created_new_order).toBe(true);
      expect(result.previous_order_id).toBe("ORD-EXIST-3");
      expect(result.order_id).toBe(INSERTED_ORDER_FIXTURE.order_id);
      expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled(); // old draft never mutated, only a fresh insert happens
    });
  });
});
