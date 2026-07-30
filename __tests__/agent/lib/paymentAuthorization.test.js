const { issuePaymentAuthorization, hashPaymentToken, DEFAULT_TTL_MS, TOKEN_BYTES, ISSUE_RPC_NAME } = require("../../../lib/payment/paymentAuthorization");
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

// Simulates the RPC always minting/keeping p_candidate_attempt_id as-is —
// good enough for THIS file's unit tests (the "same summary -> same
// attempt id" decision itself is exercised by
// __tests__/agent/lib/a3ClosedLoop.test.js and the static SQL assertions in
// __tests__/agent/sql/migrationPaymentAuthorizationStatic.test.js, not here).
function acceptCandidateRpc() {
  return (name, args) => {
    if (name !== ISSUE_RPC_NAME) return { data: null, error: { message: "unknown rpc" } };
    return { data: [{ order_id: args.p_order_id, payment_attempt_id: args.p_candidate_attempt_id }], error: null };
  };
}

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
    const supabase = createMockSupabase({ rpc: acceptCandidateRpc() });
    const result = await issuePaymentAuthorization({ supabase, order: null });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test("calls the atomic issue_payment_authorization_v1 RPC, never a plain .from(orders).update()", async () => {
    const supabase = createMockSupabase({ rpc: acceptCandidateRpc() });
    await issuePaymentAuthorization({ supabase, order: ORDER });
    expect(supabase.__calls.rpc.length).toBe(1);
    expect(supabase.__calls.rpc[0].name).toBe(ISSUE_RPC_NAME);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("raw token is >= 32 random bytes (>= 64 hex chars), never all-zero", async () => {
    const supabase = createMockSupabase({ rpc: acceptCandidateRpc() });
    const result = await issuePaymentAuthorization({ supabase, order: ORDER });
    expect(result.ok).toBe(true);
    expect(typeof result.token).toBe("string");
    expect(result.token.length).toBeGreaterThanOrEqual(TOKEN_BYTES * 2); // hex encoding
    expect(result.token).not.toMatch(/^0+$/);
  });

  test("two consecutive issuances produce two different raw tokens and two different candidate attempt ids", async () => {
    const supabase = createMockSupabase({ rpc: acceptCandidateRpc() });
    const r1 = await issuePaymentAuthorization({ supabase, order: ORDER });
    const r2 = await issuePaymentAuthorization({ supabase, order: ORDER });
    expect(r1.token).not.toBe(r2.token);
    expect(supabase.__calls.rpc[0].args.p_candidate_attempt_id).not.toBe(supabase.__calls.rpc[1].args.p_candidate_attempt_id);
  });

  test("sends ONLY the token HASH to the RPC, never the raw token", async () => {
    const supabase = createMockSupabase({ rpc: acceptCandidateRpc() });
    const result = await issuePaymentAuthorization({ supabase, order: ORDER });

    const rpcArgs = supabase.__calls.rpc[0].args;
    expect(rpcArgs.p_token_hash).toBe(hashPaymentToken(result.token));
    expect(JSON.stringify(rpcArgs)).not.toContain(result.token);
  });

  test("sends the current summary_hash (lib/agent/bookingSummary.js's shared algorithm) and the fixed 500 deposit", async () => {
    const supabase = createMockSupabase({ rpc: acceptCandidateRpc() });
    await issuePaymentAuthorization({ supabase, order: ORDER });

    const rpcArgs = supabase.__calls.rpc[0].args;
    expect(rpcArgs.p_summary_hash).toBe(computeSummaryHash(ORDER));
    expect(rpcArgs.p_deposit_amount).toBe(500);
  });

  test("always sends the fixed 500 deposit even if the order's own deposit_amount was tampered with", async () => {
    const supabase = createMockSupabase({ rpc: acceptCandidateRpc() });
    await issuePaymentAuthorization({ supabase, order: { ...ORDER, deposit_amount: 1 } });

    const rpcArgs = supabase.__calls.rpc[0].args;
    expect(rpcArgs.p_deposit_amount).toBe(500);
  });

  test("default TTL is 10 minutes", async () => {
    const supabase = createMockSupabase({ rpc: acceptCandidateRpc() });
    const before = Date.now();
    const result = await issuePaymentAuthorization({ supabase, order: ORDER });
    const after = Date.now();

    expect(DEFAULT_TTL_MS).toBe(10 * 60 * 1000);
    const expiresAtMs = new Date(result.expires_at).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + DEFAULT_TTL_MS - 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + DEFAULT_TTL_MS + 1000);

    const rpcArgs = supabase.__calls.rpc[0].args;
    expect(rpcArgs.p_expires_at).toBe(result.expires_at);
  });

  test("returns the RPC's authoritative payment_attempt_id, not necessarily the candidate it sent", async () => {
    const AUTHORITATIVE_ATTEMPT_ID = "authoritative-attempt-id-from-rpc";
    const supabase = createMockSupabase({
      rpc: (name) => (name === ISSUE_RPC_NAME ? { data: [{ order_id: ORDER.order_id, payment_attempt_id: AUTHORITATIVE_ATTEMPT_ID }], error: null } : { data: null, error: { message: "unknown rpc" } }),
    });
    const result = await issuePaymentAuthorization({ supabase, order: ORDER });
    expect(result.ok).toBe(true);
    expect(result.payment_attempt_id).toBe(AUTHORITATIVE_ATTEMPT_ID);
  });

  test("database error on RPC -> payment_authorization_failed", async () => {
    const supabase = createMockSupabase({ rpc: () => ({ data: null, error: { message: "db down" } }) });
    const result = await issuePaymentAuthorization({ supabase, order: ORDER });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_AUTHORIZATION_FAILED);
  });

  test("unexpected response shape (not a 1-row array) -> payment_authorization_failed, never hands back a token", async () => {
    const supabase = createMockSupabase({ rpc: () => ({ data: [], error: null }) });
    const result = await issuePaymentAuthorization({ supabase, order: ORDER });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_AUTHORIZATION_FAILED);
  });

  test("RPC row missing payment_attempt_id -> payment_authorization_failed, never hands back a token", async () => {
    const supabase = createMockSupabase({ rpc: () => ({ data: [{ order_id: ORDER.order_id, payment_attempt_id: null }], error: null }) });
    const result = await issuePaymentAuthorization({ supabase, order: ORDER });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.PAYMENT_AUTHORIZATION_FAILED);
  });
});
