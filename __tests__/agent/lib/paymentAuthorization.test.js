const { issuePaymentAuthorization, hashPaymentToken, DEFAULT_TTL_MS, TOKEN_BYTES } = require("../../../lib/payment/paymentAuthorization");
const { computeSummaryHash } = require("../../../lib/agent/bookingSummary");
const { createMockSupabase } = require("../../helpers/mockSupabase");
const { AGENT_ERROR_CODES } = require("../../../lib/agent/errorCodes");

const CAR = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";

const ORDER = {
  order_id: "ORD-20990901-77777",
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
};

describe("hashPaymentToken", () => {
  test("deterministic sha256 hex digest", () => {
    const h1 = hashPaymentToken("same-raw-token");
    const h2 = hashPaymentToken("same-raw-token");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("different tokens hash differently", () => {
    expect(hashPaymentToken("a")).not.toBe(hashPaymentToken("b"));
  });
});

describe("issuePaymentAuthorization", () => {
  test("missing order/order_id -> invalid_request, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: [{ order_id: ORDER.order_id }], error: null } } });
    const result = await issuePaymentAuthorization({ supabase, order: null });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("raw token is >= 32 random bytes (>= 64 hex chars), never all-zero", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: [{ order_id: ORDER.order_id }], error: null } } });
    const result = await issuePaymentAuthorization({ supabase, order: ORDER });
    expect(result.ok).toBe(true);
    expect(typeof result.token).toBe("string");
    expect(result.token.length).toBeGreaterThanOrEqual(TOKEN_BYTES * 2); // hex encoding
    expect(result.token).not.toMatch(/^0+$/);
  });

  test("two consecutive issuances produce two different raw tokens", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: [{ order_id: ORDER.order_id }], error: null } } });
    const r1 = await issuePaymentAuthorization({ supabase, order: ORDER });
    const r2 = await issuePaymentAuthorization({ supabase, order: ORDER });
    expect(r1.token).not.toBe(r2.token);
  });

  test("writes ONLY the token HASH to the database, never the raw token", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: [{ order_id: ORDER.order_id }], error: null } } });
    const result = await issuePaymentAuthorization({ supabase, order: ORDER });

    const updatePayload = supabase.__tableCalls.orders.update.mock.calls[0][0];
    expect(updatePayload.payment_authorization_token_hash).toBe(hashPaymentToken(result.token));
    expect(JSON.stringify(updatePayload)).not.toContain(result.token);
  });

  test("binds the current summary_hash (lib/agent/bookingSummary.js's shared algorithm) and the fixed 500 deposit", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: [{ order_id: ORDER.order_id }], error: null } } });
    await issuePaymentAuthorization({ supabase, order: ORDER });

    const updatePayload = supabase.__tableCalls.orders.update.mock.calls[0][0];
    expect(updatePayload.payment_authorization_summary_hash).toBe(computeSummaryHash(ORDER));
    expect(updatePayload.payment_authorization_deposit_amount).toBe(500);
  });

  test("always binds the fixed 500 deposit even if the order's own deposit_amount was tampered with", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: [{ order_id: ORDER.order_id }], error: null } } });
    await issuePaymentAuthorization({ supabase, order: { ...ORDER, deposit_amount: 1 } });

    const updatePayload = supabase.__tableCalls.orders.update.mock.calls[0][0];
    expect(updatePayload.payment_authorization_deposit_amount).toBe(500);
  });

  test("resets consumed_at to null on every issuance (a fresh authorization is always unconsumed)", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: [{ order_id: ORDER.order_id }], error: null } } });
    await issuePaymentAuthorization({ supabase, order: ORDER });

    const updatePayload = supabase.__tableCalls.orders.update.mock.calls[0][0];
    expect(updatePayload.payment_authorization_consumed_at).toBeNull();
  });

  test("default TTL is 10 minutes", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: [{ order_id: ORDER.order_id }], error: null } } });
    const before = Date.now();
    const result = await issuePaymentAuthorization({ supabase, order: ORDER });
    const after = Date.now();

    expect(DEFAULT_TTL_MS).toBe(10 * 60 * 1000);
    const expiresAtMs = new Date(result.expires_at).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + DEFAULT_TTL_MS - 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + DEFAULT_TTL_MS + 1000);
  });

  test("re-issuing overwrites the previous authorization in a single UPDATE targeted at this order_id", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: [{ order_id: ORDER.order_id }], error: null } } });
    await issuePaymentAuthorization({ supabase, order: ORDER });
    await issuePaymentAuthorization({ supabase, order: ORDER });

    expect(supabase.__tableCalls.orders.update.mock.calls.length).toBe(2);
    for (const call of supabase.__tableCalls.orders.eq.mock.calls) {
      expect(call).toEqual(["order_id", ORDER.order_id]);
    }
  });

  test("database error on write -> payment_authorization_failed", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: null, error: { message: "db down" } } } });
    const result = await issuePaymentAuthorization({ supabase, order: ORDER });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_AUTHORIZATION_FAILED);
  });

  test("unexpected response shape (not a 1-row array) -> payment_authorization_failed, never hands back a token", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: [], error: null } } });
    const result = await issuePaymentAuthorization({ supabase, order: ORDER });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_AUTHORIZATION_FAILED);
  });
});
