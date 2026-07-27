const { createBookingDraftTool, hashIdempotencyKey, normalizeForIdempotencyHash, IDEMPOTENCY_REQUEST_FIELDS } = require("../../../lib/agent/tools/createBookingDraft");
const { computeFieldsHash } = require("../../../lib/agent/hashUtils");
const { createMockSupabase } = require("../../helpers/mockSupabase");
const { AGENT_ERROR_CODES } = require("../../../lib/agent/errorCodes");
const { TEST_AGENT_BOOKING_TOKEN_SECRET } = require("../helpers/testSecrets");

const CAR = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";

const VALID_INPUT = {
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

const KEY = "test-idempotency-key-1";

function requestHashFor(input) {
  return computeFieldsHash(IDEMPOTENCY_REQUEST_FIELDS, normalizeForIdempotencyHash(input));
}

const NOT_FOUND = { data: null, error: null }; // pre-check / race-lookup: no existing row yet
const AVAILABLE_INVENTORY = { inventory_rules_v2: { data: [{ date: "2099-09-01", remaining_qty_calc: 3 }], error: null } };
const SOLD_OUT_INVENTORY = { inventory_rules_v2: { data: [{ date: "2099-09-01", remaining_qty_calc: 0 }], error: null } };

const INSERTED_ORDER_FIXTURE = {
  order_id: "ORD-20990901-54321",
  payment_status: "draft",
  inventory_status: "pending",
  total_price: 1600,
  deposit_amount: 500,
};

beforeEach(() => {
  process.env.AGENT_BOOKING_TOKEN_SECRET = TEST_AGENT_BOOKING_TOKEN_SECRET;
});

afterEach(() => {
  delete process.env.AGENT_BOOKING_TOKEN_SECRET;
});

describe("createBookingDraftTool — A1-B01: existing_order_id removed", () => {
  test("existing_order_id in the body -> invalid_request, ZERO database reads", async () => {
    const supabase = createMockSupabase({ from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } }, rpc: () => ({ data: 1600, error: null }) });

    const result = await createBookingDraftTool({ supabase, data: { ...VALID_INPUT, existing_order_id: "ORD-1" }, idempotencyKey: KEY });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test("order_id in the body -> invalid_request, ZERO database reads", async () => {
    const supabase = createMockSupabase({ from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } }, rpc: () => ({ data: 1600, error: null }) });

    const result = await createBookingDraftTool({ supabase, data: { ...VALID_INPUT, order_id: "ORD-CLIENT-SUPPLIED" }, idempotencyKey: KEY });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test("output never contains previous_order_id / created_new_order (the removed reuse-vs-supersede distinction)", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [NOT_FOUND, { data: [INSERTED_ORDER_FIXTURE], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty("previous_order_id");
    expect(result).not.toHaveProperty("created_new_order");
  });
});

describe("createBookingDraftTool — Idempotency-Key: header shape", () => {
  test("missing Idempotency-Key -> invalid_request, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } }, rpc: () => ({ data: 1600, error: null }) });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: undefined });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("blank/whitespace-only Idempotency-Key -> invalid_request", async () => {
    const supabase = createMockSupabase({ from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } }, rpc: () => ({ data: 1600, error: null }) });
    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: "   " });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
  });

  test("absurdly long Idempotency-Key -> invalid_request", async () => {
    const supabase = createMockSupabase({ from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } }, rpc: () => ({ data: 1600, error: null }) });
    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: "x".repeat(500) });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
  });

  test("AGENT_BOOKING_TOKEN_SECRET missing -> fails closed BEFORE any database call", async () => {
    delete process.env.AGENT_BOOKING_TOKEN_SECRET;
    const supabase = createMockSupabase({ from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } }, rpc: () => ({ data: 1600, error: null }) });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe("createBookingDraftTool — brand-new key (pre-check finds nothing)", () => {
  test("inserts once, returns the new order + a fresh token", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [NOT_FOUND, { data: [INSERTED_ORDER_FIXTURE], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(true);
    expect(result.order_id).toBe(INSERTED_ORDER_FIXTURE.order_id);
    expect(typeof result.booking_access_token).toBe("string");
  });

  test("pre-check SELECT never uses select('*') — always the fixed whitelist column list", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [NOT_FOUND, { data: [INSERTED_ORDER_FIXTURE], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    const firstSelectArg = supabase.__tableCalls.orders.select.mock.calls[0][0];
    expect(firstSelectArg).not.toBe("*");
    expect(firstSelectArg).toContain("order_id");
  });

  test("never trusts caller-supplied total_price/deposit_amount/payment_status/inventory_status/stripe_session_id", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [NOT_FOUND, { data: [INSERTED_ORDER_FIXTURE], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({
      supabase,
      data: { ...VALID_INPUT, total_price: 1, deposit_amount: 1, payment_status: "paid", inventory_status: "locked", stripe_session_id: "cs_fake" },
      idempotencyKey: KEY,
    });

    expect(result.ok).toBe(true);
    expect(result.total_price).toBe(1600);
    expect(result.deposit_amount).toBe(500);
    const insertArgs = supabase.__tableCalls.orders.upsert.mock.calls[0][0];
    expect(insertArgs.payment_status).toBe("draft");
    expect(insertArgs.inventory_status).toBe("pending");
    expect(insertArgs).not.toHaveProperty("stripe_session_id");
  });

  test("fixed source='agent' regardless of caller-supplied source", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [NOT_FOUND, { data: [INSERTED_ORDER_FIXTURE], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });
    await createBookingDraftTool({ supabase, data: { ...VALID_INPUT, source: "direct" }, idempotencyKey: KEY });
    const insertArgs = supabase.__tableCalls.orders.upsert.mock.calls[0][0];
    expect(insertArgs.source).toBe("agent");
  });

  test("sold-out inventory -> inventory_unavailable, no draft inserted", async () => {
    const supabase = createMockSupabase({
      from: { ...SOLD_OUT_INVENTORY, orders: [NOT_FOUND, { data: [INSERTED_ORDER_FIXTURE], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE);
    expect(supabase.__tableCalls.orders.upsert).not.toHaveBeenCalled();
  });

  test("missing required field -> invalid_request, no DB calls at all", async () => {
    const supabase = createMockSupabase({ from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } }, rpc: () => ({ data: 1600, error: null }) });
    const { name, ...withoutName } = VALID_INPUT;

    const result = await createBookingDraftTool({ supabase, data: withoutName, idempotencyKey: KEY });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("issues a booking_access_token that verifies against the final order_id", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [NOT_FOUND, { data: [INSERTED_ORDER_FIXTURE], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });
    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    const { verifyBookingAccessToken } = require("../../../lib/agent/tokens/bookingAccessToken");
    const verified = verifyBookingAccessToken({ token: result.booking_access_token, order_id: result.order_id });
    expect(verified.ok).toBe(true);
  });

  test("the RAW key never appears anywhere in the upsert call args (only its hash does)", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [NOT_FOUND, { data: [INSERTED_ORDER_FIXTURE], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    const upsertRow = supabase.__tableCalls.orders.upsert.mock.calls[0][0];
    expect(JSON.stringify(upsertRow)).not.toContain(KEY);
    expect(upsertRow.agent_idempotency_key_hash).toBe(hashIdempotencyKey(KEY));
  });

  test("upsert targets agent_idempotency_key_hash with ignoreDuplicates:true (the real atomic-concurrency primitive)", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [NOT_FOUND, { data: [INSERTED_ORDER_FIXTURE], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    const upsertOpts = supabase.__tableCalls.orders.upsert.mock.calls[0][1];
    expect(upsertOpts).toEqual({ onConflict: "agent_idempotency_key_hash", ignoreDuplicates: true });
  });
});

describe("createBookingDraftTool — retry fast path: pre-check finds an existing order", () => {
  test("same key + SAME (normalized) request -> returns the SAME order_id + a NEW token, WITHOUT touching inventory or issuing a write", async () => {
    const existingRow = { ...INSERTED_ORDER_FIXTURE, agent_idempotency_request_hash: requestHashFor(VALID_INPUT) };
    const supabase = createMockSupabase({
      from: { orders: { data: existingRow, error: null } }, // only ONE orders call: the pre-check
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(true);
    expect(result.order_id).toBe(existingRow.order_id);
    expect(typeof result.booking_access_token).toBe("string");
    expect(supabase.__tableCalls.orders.upsert).not.toHaveBeenCalled(); // no write attempted
    expect(supabase.rpc).not.toHaveBeenCalled(); // no price lookup
    expect(supabase.from).not.toHaveBeenCalledWith("inventory_rules_v2"); // no availability check
  });

  test("formatting-only differences (driver_lang case, numeric-vs-string duration/pax/luggage, incidental whitespace) still count as the SAME request", async () => {
    const messyButEquivalentInput = {
      ...VALID_INPUT,
      driver_lang: "ZH", // VALID_INPUT uses lowercase "zh"
      duration: "8", // VALID_INPUT uses the number 8
      pax: "2",
      luggage: "1",
      name: "  Zhang San  ", // incidental whitespace
    };
    const existingRow = { ...INSERTED_ORDER_FIXTURE, agent_idempotency_request_hash: requestHashFor(VALID_INPUT) };
    const supabase = createMockSupabase({ from: { orders: { data: existingRow, error: null } }, rpc: () => ({ data: 1600, error: null }) });

    const result = await createBookingDraftTool({ supabase, data: messyButEquivalentInput, idempotencyKey: KEY });

    expect(result.ok).toBe(true);
    expect(result.order_id).toBe(existingRow.order_id);
  });

  test("same key + DIFFERENT request -> 409 idempotency_conflict, no order returned, no write attempted", async () => {
    const existingRow = { ...INSERTED_ORDER_FIXTURE, agent_idempotency_request_hash: "a-completely-different-hash-value" };
    const supabase = createMockSupabase({ from: { orders: { data: existingRow, error: null } }, rpc: () => ({ data: 1600, error: null }) });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.IDEMPOTENCY_CONFLICT);
    expect(result.order_id).toBeUndefined();
    expect(supabase.__tableCalls.orders.upsert).not.toHaveBeenCalled();
  });
});

describe("createBookingDraftTool — genuine concurrent race (pre-check finds nothing for BOTH callers)", () => {
  test("the losing call's insert observes the conflict (data: []) and reads back the SAME winner order_id", async () => {
    const requestHash = requestHashFor(VALID_INPUT);

    // Call 1: pre-check finds nothing, wins the real insert race.
    const supabase1 = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [NOT_FOUND, { data: [INSERTED_ORDER_FIXTURE], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });
    const result1 = await createBookingDraftTool({ supabase: supabase1, data: VALID_INPUT, idempotencyKey: KEY });

    // Call 2: its OWN pre-check also found nothing (truly concurrent —
    // call 1 had not committed yet when call 2's pre-check ran), but by the
    // time call 2 reaches the atomic insert, call 1 has already committed,
    // so call 2's insert observes the conflict (data: []) and must read the
    // real winner.
    const existingRow = { ...INSERTED_ORDER_FIXTURE, agent_idempotency_request_hash: requestHash };
    const supabase2 = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [NOT_FOUND, { data: [], error: null }, { data: existingRow, error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });
    const result2 = await createBookingDraftTool({ supabase: supabase2, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    expect(result1.order_id).toBe(result2.order_id); // exactly one authoritative order
    // Both calls independently issue a fresh, validly-signed token for that
    // SAME order_id. Note: a token is a deterministic HMAC over
    // {order_id, purpose, issued_at, expires_at} (see bookingAccessToken.js)
    // — if both calls happen to land in the same millisecond (routine in a
    // fast synchronous test), issued_at/expires_at match too and the two
    // tokens are legitimately byte-identical. That is not a bug: nothing
    // about this design requires two tokens for the same order to differ,
    // only that each is independently valid. Assert validity instead.
    const { verifyBookingAccessToken } = require("../../../lib/agent/tokens/bookingAccessToken");
    expect(verifyBookingAccessToken({ token: result1.booking_access_token, order_id: result1.order_id }).ok).toBe(true);
    expect(verifyBookingAccessToken({ token: result2.booking_access_token, order_id: result2.order_id }).ok).toBe(true);
  });

  test("the losing call's insert observes data: null and still reads back the same winner", async () => {
    const requestHash = requestHashFor(VALID_INPUT);
    const existingRow = { ...INSERTED_ORDER_FIXTURE, agent_idempotency_request_hash: requestHash };
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [NOT_FOUND, { data: null, error: null }, { data: existingRow, error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(true);
    expect(result.order_id).toBe(existingRow.order_id);
  });

  test("the race winner's content actually differs (a genuinely different concurrent request reused the key) -> 409 idempotency_conflict", async () => {
    const existingRow = { ...INSERTED_ORDER_FIXTURE, agent_idempotency_request_hash: "some-other-request-hash" };
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [NOT_FOUND, { data: [], error: null }, { data: existingRow, error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.IDEMPOTENCY_CONFLICT);
  });

  test("order_id collision (a DIFFERENT unique constraint) still retries with a fresh candidate id, independent of the idempotency-key logic", async () => {
    const orderIdCollision = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"orders_pkey\"" } };
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [NOT_FOUND, orderIdCollision, { data: [INSERTED_ORDER_FIXTURE], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(true);
    expect(result.order_id).toBe(INSERTED_ORDER_FIXTURE.order_id);
    expect(supabase.__tableCalls.orders.upsert.mock.calls.length).toBe(2);
  });

  test("a genuinely unrelated database error on upsert -> draft_creation_failed, no retry loop wasted on it", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [NOT_FOUND, { data: null, error: { code: "42501", message: "permission denied" } }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.DRAFT_CREATION_FAILED);
    expect(supabase.__tableCalls.orders.upsert.mock.calls.length).toBe(1); // not retried
  });

  test("upsert unexpectedly returns MULTIPLE rows -> stable failure, no token issued", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [NOT_FOUND, { data: [INSERTED_ORDER_FIXTURE, { ...INSERTED_ORDER_FIXTURE, order_id: "ORD-OTHER" }], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.DRAFT_CREATION_FAILED);
    expect(result.booking_access_token).toBeUndefined();
    expect(supabase.__tableCalls.orders.upsert.mock.calls.length).toBe(1);
  });

  test("upsert returns a completely unrecognized data shape -> stable failure, no token issued", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [NOT_FOUND, { data: { unexpected: "shape" }, error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.DRAFT_CREATION_FAILED);
    expect(result.booking_access_token).toBeUndefined();
  });
});

describe("createBookingDraftTool — validation runs before any DB/RPC call", () => {
  test("invalid input (bad email) -> invalid_request, zero supabase.from/.rpc calls at all", async () => {
    const supabase = createMockSupabase({ from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } }, rpc: () => ({ data: 1600, error: null }) });

    const result = await createBookingDraftTool({ supabase, data: { ...VALID_INPUT, email: "not-an-email" }, idempotencyKey: KEY });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test("driver_lang alias not in the strict set ('ja') -> invalid_request, never silently normalized to ZH", async () => {
    const supabase = createMockSupabase({ from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } }, rpc: () => ({ data: 1600, error: null }) });

    const result = await createBookingDraftTool({ supabase, data: { ...VALID_INPUT, driver_lang: "ja" }, idempotencyKey: KEY });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe("normalizeForIdempotencyHash — direct unit coverage", () => {
  test("driver_lang case is canonicalized", () => {
    expect(normalizeForIdempotencyHash({ ...VALID_INPUT, driver_lang: "zh" }).driver_lang).toBe("ZH");
    expect(normalizeForIdempotencyHash({ ...VALID_INPUT, driver_lang: "ZH" }).driver_lang).toBe("ZH");
  });

  test("numeric-looking strings normalize to real numbers, matching the native-number form", () => {
    const a = normalizeForIdempotencyHash({ ...VALID_INPUT, duration: 8, pax: 2, luggage: 1 });
    const b = normalizeForIdempotencyHash({ ...VALID_INPUT, duration: "8", pax: "2", luggage: "1" });
    expect(a).toEqual(b);
    expect(typeof a.duration).toBe("number");
  });

  test("required text is trimmed", () => {
    expect(normalizeForIdempotencyHash({ ...VALID_INPUT, name: "  Zhang San  " }).name).toBe("Zhang San");
  });

  test("blank optional fields normalize to null, whether omitted, empty, or whitespace-only", () => {
    const omitted = normalizeForIdempotencyHash({ ...VALID_INPUT });
    const empty = normalizeForIdempotencyHash({ ...VALID_INPUT, wechat: "", itinerary: "   " });
    expect(omitted.wechat).toBeNull();
    expect(empty.wechat).toBeNull();
    expect(empty.itinerary).toBeNull();
  });

  test("a genuine content difference (different start_date) still normalizes to a different value", () => {
    const a = normalizeForIdempotencyHash(VALID_INPUT);
    const b = normalizeForIdempotencyHash({ ...VALID_INPUT, start_date: "2099-10-01" });
    expect(a.start_date).not.toBe(b.start_date);
  });
});
