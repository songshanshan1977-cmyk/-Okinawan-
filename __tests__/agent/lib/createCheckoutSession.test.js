const { createCheckoutSession, RPC_NAME, STRIPE_IDEMPOTENCY_KEY_PREFIX } = require("../../../lib/payment/createCheckoutSession");
const { computeSummaryHash } = require("../../../lib/agent/bookingSummary");
const { createMockSupabase } = require("../../helpers/mockSupabase");
const { AGENT_ERROR_CODES } = require("../../../lib/agent/errorCodes");

const CONSUMED_ORDER_BASE = {
  order_id: "ORD-20990901-88888",
  start_date: "2099-09-01",
  end_date: "2099-09-01",
  car_model_id: "car-x",
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
const VALID_BOUND_HASH = computeSummaryHash(CONSUMED_ORDER_BASE);
const ATTEMPT_ID = "attempt-id-fixed-for-tests";

function validConsumedRow(overrides = {}) {
  return {
    ...CONSUMED_ORDER_BASE,
    payment_authorization_summary_hash: VALID_BOUND_HASH,
    payment_authorization_deposit_amount: 500,
    payment_attempt_id: ATTEMPT_ID,
    stripe_session_id: null,
    ...overrides,
  };
}

function fakeStripe(createImpl) {
  return { checkout: { sessions: { create: jest.fn(createImpl) } } };
}

const FULL_INVENTORY = [{ date: "2099-09-01", remaining_qty_calc: 3 }];
const SOLD_OUT_INVENTORY = [{ date: "2099-09-01", remaining_qty_calc: 0 }];

// Write-back fixture that "echoes" a specific session id, matching what a
// real UPDATE ... SET stripe_session_id = <that value> ... SELECT would
// return. Callers pick the session id their fakeStripe will produce.
function writeBackFixture(sessionId) {
  return { data: [{ order_id: CONSUMED_ORDER_BASE.order_id, stripe_session_id: sessionId, payment_status: "pending" }], error: null };
}

function mockSupabaseFor({ rpcResult, inventoryRows = FULL_INVENTORY, orderUpdateResult = writeBackFixture("cs_default") }) {
  return createMockSupabase({
    from: { orders: orderUpdateResult, inventory_rules_v2: { data: inventoryRows, error: null } },
    rpc: () => rpcResult,
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://sandbox.invalid";
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.SITE_URL;
});

describe("createCheckoutSession — input/env gates", () => {
  test("missing order_id -> invalid_request, zero rpc calls", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: undefined, payment_token: "t" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.__calls.rpc.length).toBe(0);
  });

  test("missing payment_token -> invalid_request, zero rpc calls", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: undefined });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.__calls.rpc.length).toBe(0);
  });

  test("SITE_URL not configured -> payment_session_failed, zero rpc calls", async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.SITE_URL;
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED);
    expect(supabase.__calls.rpc.length).toBe(0);
  });
});

describe("createCheckoutSession — atomic consumption via consume_payment_authorization_v1", () => {
  test("hashes the raw token before calling the RPC — the RPC never sees the raw token", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null }, orderUpdateResult: writeBackFixture("cs_1") });
    const stripe = fakeStripe(() => Promise.resolve({ id: "cs_1", url: "https://stripe.invalid/1" }));
    await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "raw-secret-token" });

    const rpcCall = supabase.__calls.rpc[0];
    expect(rpcCall.name).toBe(RPC_NAME);
    expect(rpcCall.args.p_order_id).toBe(CONSUMED_ORDER_BASE.order_id);
    expect(rpcCall.args.p_token_hash).not.toBe("raw-secret-token");
    expect(rpcCall.args.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("RPC database error -> payment_session_failed, zero Stripe calls", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: null, error: { message: "db down" } } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test("RPC returns zero rows (no match: wrong order, wrong token, expired, or already consumed) -> payment_authorization_expired_or_used, zero Stripe calls", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [], error: null } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_AUTHORIZATION_EXPIRED_OR_USED);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test("RPC returns more than one row (shape anomaly) -> payment_session_failed, never guesses", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow(), validConsumedRow()], error: null } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("createCheckoutSession — post-consumption re-verification", () => {
  test("live summary_hash differs from the hash the authorization was bound to -> payment_summary_stale, zero Stripe calls", async () => {
    const staleRow = validConsumedRow({ duration: 10 }); // content changed after authorization was issued
    const supabase = mockSupabaseFor({ rpcResult: { data: [staleRow], error: null } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SUMMARY_STALE);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test("order's current deposit_amount no longer matches the bound authorization deposit -> payment_summary_stale", async () => {
    const row = validConsumedRow({ deposit_amount: 999, payment_authorization_deposit_amount: 500 });
    const supabase = mockSupabaseFor({ rpcResult: { data: [row], error: null } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SUMMARY_STALE);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test("bound deposit is not the fixed 500 -> payment_summary_stale", async () => {
    const row = validConsumedRow({ deposit_amount: 1, payment_authorization_deposit_amount: 1 });
    const supabase = mockSupabaseFor({ rpcResult: { data: [row], error: null } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SUMMARY_STALE);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test("inventory unavailable -> inventory_unavailable with unavailable_dates, zero Stripe calls", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null }, inventoryRows: SOLD_OUT_INVENTORY });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.code).toBe(AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE);
    expect(result.unavailable_dates).toEqual([{ date: "2099-09-01", reason: "sold_out" }]);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test("RPC row missing payment_attempt_id -> payment_session_failed, zero Stripe calls (structurally should be impossible, never build an idempotency key off it anyway)", async () => {
    const row = validConsumedRow({ payment_attempt_id: null });
    const supabase = mockSupabaseFor({ rpcResult: { data: [row], error: null } });
    const stripe = fakeStripe();
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("createCheckoutSession — Stripe idempotency key (payment-attempt idempotency)", () => {
  test("passes idempotencyKey = 'checkout:' + payment_attempt_id as Stripe's second argument", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null }, orderUpdateResult: writeBackFixture("cs_key_1") });
    const stripe = fakeStripe(() => Promise.resolve({ id: "cs_key_1", url: "https://stripe.invalid/pay/cs_key_1" }));

    await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });

    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    const [params, options] = stripe.checkout.sessions.create.mock.calls[0];
    expect(options).toEqual({ idempotencyKey: `${STRIPE_IDEMPOTENCY_KEY_PREFIX}${ATTEMPT_ID}` });
    expect(params).not.toHaveProperty("idempotencyKey"); // key travels via the options arg, never inline in params
  });

  test("two calls for the SAME payment_attempt_id use the SAME idempotencyKey, even with two different raw tokens/hashes (simulating a retry with a freshly re-issued authorization)", async () => {
    const rowForCall1 = validConsumedRow();
    const rowForCall2 = validConsumedRow(); // same payment_attempt_id, as issue_payment_authorization_v1 would produce on retry
    let call = 0;
    const supabase = createMockSupabase({
      from: { orders: writeBackFixture("cs_retry_1"), inventory_rules_v2: { data: FULL_INVENTORY, error: null } },
      rpc: (name) => {
        if (name !== RPC_NAME) return { data: null, error: { message: "unknown rpc" } };
        call += 1;
        return { data: [call === 1 ? rowForCall1 : rowForCall2], error: null };
      },
    });
    const stripe = fakeStripe(() => Promise.resolve({ id: "cs_retry_1", url: "https://stripe.invalid/pay/cs_retry_1" }));

    await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "first-attempt-token" });
    await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "second-attempt-token-after-reissue" });

    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
    const key1 = stripe.checkout.sessions.create.mock.calls[0][1].idempotencyKey;
    const key2 = stripe.checkout.sessions.create.mock.calls[1][1].idempotencyKey;
    expect(key1).toBe(key2);
    expect(key1).toBe(`${STRIPE_IDEMPOTENCY_KEY_PREFIX}${ATTEMPT_ID}`);
  });

  test("Stripe params are byte-identical across two calls for the same attempt (deterministic from consumedOrder alone, never from the raw token)", async () => {
    const supabase = createMockSupabase({
      from: { orders: writeBackFixture("cs_stable_1"), inventory_rules_v2: { data: FULL_INVENTORY, error: null } },
      rpc: (name) => (name === RPC_NAME ? { data: [validConsumedRow()], error: null } : { data: null, error: { message: "unknown rpc" } }),
    });
    const stripe = fakeStripe(() => Promise.resolve({ id: "cs_stable_1", url: "https://stripe.invalid/pay/cs_stable_1" }));

    await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "token-A" });
    await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "token-B-totally-different" });

    const params1 = stripe.checkout.sessions.create.mock.calls[0][0];
    const params2 = stripe.checkout.sessions.create.mock.calls[1][0];
    expect(params1).toEqual(params2);
  });
});

describe("createCheckoutSession — Stripe response validation", () => {
  test("Stripe response missing id -> payment_session_failed, no write-back attempted", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null } });
    const stripe = fakeStripe(() => Promise.resolve({ url: "https://stripe.invalid/pay/no-id" }));
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED);
    expect(supabase.__calls.from.filter((t) => t === "orders").length).toBe(0);
  });

  test("Stripe response missing url -> payment_session_failed, no write-back attempted", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null } });
    const stripe = fakeStripe(() => Promise.resolve({ id: "cs_no_url" }));
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SESSION_FAILED);
    expect(supabase.__calls.from.filter((t) => t === "orders").length).toBe(0);
  });
});

describe("createCheckoutSession — write-back verification", () => {
  test("valid authorization -> exactly one Stripe call, fixed 500 RMB, writes back pending + session id, verifies the write", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null }, orderUpdateResult: writeBackFixture("cs_ok_1") });
    const stripe = fakeStripe(() => Promise.resolve({ id: "cs_ok_1", url: "https://stripe.invalid/pay/cs_ok_1" }));

    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });

    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://stripe.invalid/pay/cs_ok_1");
    expect(result.order_id).toBe(CONSUMED_ORDER_BASE.order_id);
    expect(result.payment_status).toBe("pending");

    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    const callArgs = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(callArgs.line_items[0].price_data.unit_amount).toBe(50000);
    expect(callArgs.line_items[0].price_data.currency).toBe("cny");
    expect(callArgs.success_url).toContain(`order_id=${CONSUMED_ORDER_BASE.order_id}`);

    const updateCall = supabase.__tableCalls.orders.update.mock.calls[0][0];
    expect(updateCall.payment_status).toBe("pending");
    expect(updateCall.stripe_session_id).toBe("cs_ok_1");
    // The write-back re-selects and verifies — never select('*')
    const selectArg = supabase.__tableCalls.orders.select.mock.calls[0][0];
    expect(selectArg).not.toBe("*");
  });

  test("write-back DB error -> payment_session_write_failed, does NOT return a success URL", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null }, orderUpdateResult: { data: null, error: { message: "db down" } } });
    const stripe = fakeStripe(() => Promise.resolve({ id: "cs_wb_err", url: "https://stripe.invalid/pay/cs_wb_err" }));

    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SESSION_WRITE_FAILED);
    expect(result.url).toBeUndefined();
  });

  test("write-back returns zero rows -> payment_session_write_failed", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null }, orderUpdateResult: { data: [], error: null } });
    const stripe = fakeStripe(() => Promise.resolve({ id: "cs_wb_zero", url: "https://stripe.invalid/pay/cs_wb_zero" }));
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SESSION_WRITE_FAILED);
  });

  test("write-back returns a mismatched stripe_session_id -> payment_session_write_failed", async () => {
    const supabase = mockSupabaseFor({ rpcResult: { data: [validConsumedRow()], error: null }, orderUpdateResult: writeBackFixture("cs_DIFFERENT") });
    const stripe = fakeStripe(() => Promise.resolve({ id: "cs_wb_mismatch", url: "https://stripe.invalid/pay/cs_wb_mismatch" }));
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SESSION_WRITE_FAILED);
  });

  test("write-back returns payment_status other than 'pending' -> payment_session_write_failed", async () => {
    const supabase = mockSupabaseFor({
      rpcResult: { data: [validConsumedRow()], error: null },
      orderUpdateResult: { data: [{ order_id: CONSUMED_ORDER_BASE.order_id, stripe_session_id: "cs_wb_badstatus", payment_status: "draft" }], error: null },
    });
    const stripe = fakeStripe(() => Promise.resolve({ id: "cs_wb_badstatus", url: "https://stripe.invalid/pay/cs_wb_badstatus" }));
    const result = await createCheckoutSession({ supabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "t" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_SESSION_WRITE_FAILED);
  });

  test("retry after a write-back failure: same idempotencyKey resumes the SAME Stripe session, and the second attempt's write-back succeeds", async () => {
    // First call's write-back simulates a DB error; second call's write-back
    // (a retry, after a fresh authorization was re-issued) simulates success
    // — the mock helper's queue semantics deliver these in order across the
    // two separate createCheckoutSession() calls below.
    const queuedSupabase = createMockSupabase({
      from: {
        orders: [
          { data: null, error: { message: "db down" } }, // 1st attempt's write-back
          writeBackFixture("cs_recovered_1"), // 2nd attempt's write-back (recovered)
        ],
        inventory_rules_v2: { data: FULL_INVENTORY, error: null },
      },
      rpc: (name) => (name === RPC_NAME ? { data: [validConsumedRow()], error: null } : { data: null, error: { message: "unknown rpc" } }),
    });
    const stripe = fakeStripe(() => Promise.resolve({ id: "cs_recovered_1", url: "https://stripe.invalid/pay/cs_recovered_1" }));

    const first = await createCheckoutSession({ supabase: queuedSupabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "attempt-token-1" });
    expect(first.ok).toBe(false);
    expect(first.code).toBe(AGENT_ERROR_CODES.PAYMENT_SESSION_WRITE_FAILED);

    const second = await createCheckoutSession({ supabase: queuedSupabase, stripe, order_id: CONSUMED_ORDER_BASE.order_id, payment_token: "attempt-token-2-after-reissue" });
    expect(second.ok).toBe(true);
    expect(second.url).toBe("https://stripe.invalid/pay/cs_recovered_1");

    // Same idempotencyKey both times -> Stripe never asked to create a
    // second distinct session for this attempt.
    const key1 = stripe.checkout.sessions.create.mock.calls[0][1].idempotencyKey;
    const key2 = stripe.checkout.sessions.create.mock.calls[1][1].idempotencyKey;
    expect(key1).toBe(key2);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(2); // this fake always "creates"; real Stripe would return the same session object for both
  });
});
