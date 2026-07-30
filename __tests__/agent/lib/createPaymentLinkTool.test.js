const { createPaymentLinkTool, PAYMENT_LINK_LOOKUP_COLUMNS } = require("../../../lib/agent/tools/createPaymentLink");
const { computeSummaryHash, HASHED_FIELDS } = require("../../../lib/agent/bookingSummary");
const { createMockSupabase } = require("../../helpers/mockSupabase");
const { AGENT_ERROR_CODES } = require("../../../lib/agent/errorCodes");

const CAR = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";

const ORDER_CONTENT = {
  order_id: "ORD-20990901-99999",
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

function orderRow({ confirmedHash = null, confirmedAt = null, overrides = {} } = {}) {
  return {
    ...ORDER_CONTENT,
    ...overrides,
    agent_summary_confirmed_hash: confirmedHash,
    agent_summary_confirmed_at: confirmedAt,
  };
}

function consumedRowFor(order) {
  return {
    order_id: order.order_id,
    start_date: order.start_date,
    end_date: order.end_date,
    car_model_id: order.car_model_id,
    driver_lang: order.driver_lang,
    duration: order.duration,
    pax: order.pax,
    luggage: order.luggage,
    departure_hotel: order.departure_hotel,
    end_hotel: order.end_hotel,
    total_price: order.total_price,
    deposit_amount: order.deposit_amount,
    payment_status: order.payment_status,
    inventory_status: order.inventory_status,
    payment_authorization_summary_hash: computeSummaryHash(order),
    payment_authorization_deposit_amount: 500,
  };
}

const AVAILABLE_INVENTORY = { inventory_rules_v2: { data: [{ date: "2099-09-01", remaining_qty_calc: 3 }], error: null } };

function fakeStripe() {
  return { checkout: { sessions: { create: jest.fn(() => Promise.resolve({ id: "cs_pl_1", url: "https://stripe.invalid/pay/cs_pl_1" })) } } };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://sandbox.invalid";
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

describe("createPaymentLinkTool — request shape / lookup", () => {
  test("missing order_id -> invalid_request, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: orderRow(), error: null } } });
    const result = await createPaymentLinkTool({ supabase, stripe: fakeStripe(), order_id: undefined });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("order not found -> order_not_found", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: null, error: null } } });
    const result = await createPaymentLinkTool({ supabase, stripe: fakeStripe(), order_id: "ORD-NOPE" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.ORDER_NOT_FOUND);
  });

  test("order lookup uses a fixed whitelist, never select('*'), and every HASHED_FIELDS column is covered", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: orderRow(), error: null } } });
    await createPaymentLinkTool({ supabase, stripe: fakeStripe(), order_id: ORDER_CONTENT.order_id });
    const selectArg = supabase.__tableCalls.orders.select.mock.calls[0][0];
    expect(selectArg).not.toBe("*");
    for (const field of HASHED_FIELDS) {
      expect(PAYMENT_LINK_LOOKUP_COLUMNS).toContain(field);
    }
  });

  test("paid order -> paid_order_immutable, no authorization issued", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: orderRow({ overrides: { payment_status: "paid" } }), error: null } } });
    const result = await createPaymentLinkTool({ supabase, stripe: fakeStripe(), order_id: ORDER_CONTENT.order_id });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.PAID_ORDER_IMMUTABLE);
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
  });
});

describe("createPaymentLinkTool — A2 confirmation gate", () => {
  test("never confirmed (both confirmation columns null) -> 409 summary_not_confirmed, no authorization issued", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: orderRow(), error: null } } });
    const result = await createPaymentLinkTool({ supabase, stripe: fakeStripe(), order_id: ORDER_CONTENT.order_id });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.SUMMARY_NOT_CONFIRMED);
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
  });

  test("confirmed a PRIOR hash (H1), order content since changed to H2 -> 409 summary_not_confirmed", async () => {
    const staleConfirmedHash = "not-the-live-hash";
    const supabase = createMockSupabase({ from: { orders: { data: orderRow({ confirmedHash: staleConfirmedHash, confirmedAt: "2099-01-01T00:00:00.000Z" }), error: null } } });
    const result = await createPaymentLinkTool({ supabase, stripe: fakeStripe(), order_id: ORDER_CONTENT.order_id });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.SUMMARY_NOT_CONFIRMED);
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
  });

  test("confirmed_hash matches live hash but confirmed_at is missing -> 409 summary_not_confirmed", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: orderRow({ confirmedHash: LIVE_HASH, confirmedAt: null }), error: null } } });
    const result = await createPaymentLinkTool({ supabase, stripe: fakeStripe(), order_id: ORDER_CONTENT.order_id });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.SUMMARY_NOT_CONFIRMED);
  });
});

describe("createPaymentLinkTool — confirmed and current -> issues + consumes + creates session", () => {
  function buildSupabaseForSuccess() {
    const row = orderRow({ confirmedHash: LIVE_HASH, confirmedAt: "2099-01-01T00:00:00.000Z" });
    return createMockSupabase({
      from: {
        orders: [
          { data: row, error: null }, // lookup
          { data: [{ order_id: row.order_id }], error: null }, // issuePaymentAuthorization update
          { data: null, error: null }, // createCheckoutSession write-back update
        ],
        ...AVAILABLE_INVENTORY,
      },
      rpc: (name) => (name === "consume_payment_authorization_v1" ? { data: [consumedRowFor(row)], error: null } : { data: null, error: null }),
    });
  }

  test("confirmed current hash -> ok, pending, url present, expires_at present", async () => {
    const supabase = buildSupabaseForSuccess();
    const stripe = fakeStripe();
    const result = await createPaymentLinkTool({ supabase, stripe, order_id: ORDER_CONTENT.order_id });

    expect(result.ok).toBe(true);
    expect(result.order_id).toBe(ORDER_CONTENT.order_id);
    expect(result.payment_status).toBe("pending");
    expect(result.url).toBe("https://stripe.invalid/pay/cs_pl_1");
    expect(typeof result.expires_at).toBe("string");
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  test("never returns PII, token hash, summary_hash, or the raw stripe_session_id", async () => {
    const supabase = buildSupabaseForSuccess();
    const result = await createPaymentLinkTool({ supabase, stripe: fakeStripe(), order_id: ORDER_CONTENT.order_id });

    expect(Object.keys(result).sort()).toEqual(["ok", "order_id", "payment_status", "url", "expires_at"].sort());
    expect(result.stripe_session_id).toBeUndefined();
    expect(result.summary_hash).toBeUndefined();
    expect(result.name).toBeUndefined();
    expect(result.phone).toBeUndefined();
    expect(result.email).toBeUndefined();
  });

  test("Agent never sees the raw payment_token — it is only used internally against the consume RPC", async () => {
    const supabase = buildSupabaseForSuccess();
    const result = await createPaymentLinkTool({ supabase, stripe: fakeStripe(), order_id: ORDER_CONTENT.order_id });
    expect(JSON.stringify(result)).not.toMatch(/payment_token/);
  });

  test("inventory becomes unavailable between authorization and consumption -> inventory_unavailable propagated with dates", async () => {
    const row = orderRow({ confirmedHash: LIVE_HASH, confirmedAt: "2099-01-01T00:00:00.000Z" });
    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: row, error: null },
          { data: [{ order_id: row.order_id }], error: null },
        ],
        inventory_rules_v2: { data: [{ date: "2099-09-01", remaining_qty_calc: 0 }], error: null },
      },
      rpc: (name) => (name === "consume_payment_authorization_v1" ? { data: [consumedRowFor(row)], error: null } : { data: null, error: null }),
    });

    const result = await createPaymentLinkTool({ supabase, stripe: fakeStripe(), order_id: ORDER_CONTENT.order_id });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE);
    expect(result.unavailable_dates).toEqual([{ date: "2099-09-01", reason: "sold_out" }]);
  });
});
