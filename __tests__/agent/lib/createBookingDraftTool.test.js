const { createBookingDraftTool, hashIdempotencyKey } = require("../../../lib/agent/tools/createBookingDraft");
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

function computeValidInputRequestHash() {
  const { computeFieldsHash } = require("../../../lib/agent/hashUtils");
  const { IDEMPOTENCY_REQUEST_FIELDS } = require("../../../lib/agent/tools/createBookingDraft");
  return computeFieldsHash(IDEMPOTENCY_REQUEST_FIELDS, VALID_INPUT);
}

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
      from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty("previous_order_id");
    expect(result).not.toHaveProperty("created_new_order");
  });
});

describe("createBookingDraftTool — A1-B02: Idempotency-Key", () => {
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

  test("the RAW key never appears anywhere in the upsert call args (only its hash does)", async () => {
    const supabase = createMockSupabase({ from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } }, rpc: () => ({ data: 1600, error: null }) });

    await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    const upsertRow = supabase.__tableCalls.orders.upsert.mock.calls[0][0];
    expect(JSON.stringify(upsertRow)).not.toContain(KEY);
    expect(upsertRow.agent_idempotency_key_hash).toBe(hashIdempotencyKey(KEY));
  });

  test("upsert targets agent_idempotency_key_hash with ignoreDuplicates:true (the real atomic-concurrency primitive, not select-then-insert)", async () => {
    const supabase = createMockSupabase({ from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } }, rpc: () => ({ data: 1600, error: null }) });

    await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    const upsertOpts = supabase.__tableCalls.orders.upsert.mock.calls[0][1];
    expect(upsertOpts).toEqual({ onConflict: "agent_idempotency_key_hash", ignoreDuplicates: true });
  });

  test("new key -> inserts once, returns the new order + a fresh token", async () => {
    const supabase = createMockSupabase({ from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } }, rpc: () => ({ data: 1600, error: null }) });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(true);
    expect(result.order_id).toBe(INSERTED_ORDER_FIXTURE.order_id);
    expect(typeof result.booking_access_token).toBe("string");
  });

  test("same key + SAME request, replayed after the first insert already committed -> returns the SAME order + a NEW token, no second insert content", async () => {
    // First .from("orders") call: upsert absorbs the conflict (data: []).
    // Second .from("orders") call: the follow-up read-by-key_hash finds the
    // row the FIRST (different) request already created.
    const existingRow = {
      order_id: INSERTED_ORDER_FIXTURE.order_id,
      payment_status: "draft",
      inventory_status: "pending",
      total_price: 1600,
      deposit_amount: 500,
      agent_idempotency_request_hash: null, // set below once we know the real computed hash
    };

    // Compute the real request hash the tool will derive from VALID_INPUT so
    // the fixture's "existing" row matches it exactly (this IS the "same request" case).
    const { computeFieldsHash } = require("../../../lib/agent/hashUtils");
    const { IDEMPOTENCY_REQUEST_FIELDS } = require("../../../lib/agent/tools/createBookingDraft");
    existingRow.agent_idempotency_request_hash = computeFieldsHash(IDEMPOTENCY_REQUEST_FIELDS, VALID_INPUT);

    const supabase = createMockSupabase({
      from: {
        ...AVAILABLE_INVENTORY,
        orders: [{ data: [], error: null }, { data: existingRow, error: null }],
      },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(true);
    expect(result.order_id).toBe(existingRow.order_id);
    expect(typeof result.booking_access_token).toBe("string");
  });

  test("same key + DIFFERENT request -> 409 idempotency_conflict, no order returned", async () => {
    const existingRow = {
      order_id: INSERTED_ORDER_FIXTURE.order_id,
      payment_status: "draft",
      inventory_status: "pending",
      total_price: 1600,
      deposit_amount: 500,
      agent_idempotency_request_hash: "a-completely-different-hash-value",
    };

    const supabase = createMockSupabase({
      from: {
        ...AVAILABLE_INVENTORY,
        orders: [{ data: [], error: null }, { data: existingRow, error: null }],
      },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.IDEMPOTENCY_CONFLICT);
    expect(result.order_id).toBeUndefined();
  });

  describe("A1-R1-B05: defensive handling of every real upsert().select() response shape", () => {
    test("ignored duplicate returns data: [] -> queries the winner by key hash, does not treat it as a failure", async () => {
      const existingRow = { ...INSERTED_ORDER_FIXTURE, agent_idempotency_request_hash: computeValidInputRequestHash() };
      const supabase = createMockSupabase({
        from: { ...AVAILABLE_INVENTORY, orders: [{ data: [], error: null }, { data: existingRow, error: null }] },
        rpc: () => ({ data: 1600, error: null }),
      });

      const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

      expect(result.ok).toBe(true);
      expect(result.order_id).toBe(existingRow.order_id);
      expect(supabase.__tableCalls.orders.select.mock.calls.length).toBeGreaterThanOrEqual(1); // the follow-up read actually happened
    });

    test("ignored duplicate returns data: null -> ALSO queries the winner by key hash (not treated as an unknown/error shape)", async () => {
      const existingRow = { ...INSERTED_ORDER_FIXTURE, agent_idempotency_request_hash: computeValidInputRequestHash() };
      const supabase = createMockSupabase({
        from: { ...AVAILABLE_INVENTORY, orders: [{ data: null, error: null }, { data: existingRow, error: null }] },
        rpc: () => ({ data: 1600, error: null }),
      });

      const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

      expect(result.ok).toBe(true);
      expect(result.order_id).toBe(existingRow.order_id);
    });

    test("upsert unexpectedly returns MULTIPLE rows -> stable failure, no token issued, no follow-up read attempted", async () => {
      const supabase = createMockSupabase({
        from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE, { ...INSERTED_ORDER_FIXTURE, order_id: "ORD-OTHER" }], error: null } },
        rpc: () => ({ data: 1600, error: null }),
      });

      const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

      expect(result.ok).toBe(false);
      expect(result.code).toBe(AGENT_ERROR_CODES.DRAFT_CREATION_FAILED);
      expect(result.booking_access_token).toBeUndefined();
      // Only the one upsert call happened — no second .from("orders") call
      // for a "read the winner" lookup, since this isn't the "ignored
      // duplicate" case at all.
      expect(supabase.__tableCalls.orders.upsert.mock.calls.length).toBe(1);
    });

    test("upsert returns a completely unrecognized data shape (a bare object, neither null nor an array) -> stable failure, no token issued", async () => {
      const supabase = createMockSupabase({
        from: { ...AVAILABLE_INVENTORY, orders: { data: { unexpected: "shape" }, error: null } },
        rpc: () => ({ data: 1600, error: null }),
      });

      const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

      expect(result.ok).toBe(false);
      expect(result.code).toBe(AGENT_ERROR_CODES.DRAFT_CREATION_FAILED);
      expect(result.booking_access_token).toBeUndefined();
    });
  });

  test("concurrent-duplicate simulation: two sequential tool calls with the SAME key both resolve correctly without ever both inserting real content — the second's upsert is pre-configured to already observe the conflict, exactly as the real unique index would force at the DB level", async () => {
    const requestHash = (() => {
      const { computeFieldsHash } = require("../../../lib/agent/hashUtils");
      const { IDEMPOTENCY_REQUEST_FIELDS } = require("../../../lib/agent/tools/createBookingDraft");
      return computeFieldsHash(IDEMPOTENCY_REQUEST_FIELDS, VALID_INPUT);
    })();

    // Call 1: wins the race, real insert.
    const supabase1 = createMockSupabase({ from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } }, rpc: () => ({ data: 1600, error: null }) });
    const result1 = await createBookingDraftTool({ supabase: supabase1, data: VALID_INPUT, idempotencyKey: KEY });

    // Call 2: loses the race — its own upsert observes the conflict
    // (data: []), exactly what a real concurrent request would see from
    // Postgres's unique index once call 1's insert has committed.
    const existingRow = { ...INSERTED_ORDER_FIXTURE, agent_idempotency_request_hash: requestHash };
    const supabase2 = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [{ data: [], error: null }, { data: existingRow, error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });
    const result2 = await createBookingDraftTool({ supabase: supabase2, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    expect(result1.order_id).toBe(result2.order_id); // exactly one order, both calls agree on it
    expect(result1.booking_access_token).not.toBe(result2.booking_access_token); // each call still gets its own fresh token
  });

  test("order_id collision (a DIFFERENT unique constraint) still retries with a fresh candidate id, independent of the idempotency-key logic", async () => {
    const orderIdCollision = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"orders_pkey\"" } };
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [orderIdCollision, { data: [INSERTED_ORDER_FIXTURE], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(true);
    expect(result.order_id).toBe(INSERTED_ORDER_FIXTURE.order_id);
    expect(supabase.__tableCalls.orders.upsert.mock.calls.length).toBe(2);
  });

  test("a genuinely unrelated database error on upsert -> draft_creation_failed, no retry loop wasted on it", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: { data: null, error: { code: "42501", message: "permission denied" } } },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.DRAFT_CREATION_FAILED);
    expect(supabase.__tableCalls.orders.upsert.mock.calls.length).toBe(1); // not retried
  });
});

describe("createBookingDraftTool — A1-B03: validation runs before any DB/RPC call", () => {
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

describe("createBookingDraftTool — unchanged A1 guarantees still hold", () => {
  test("never trusts caller-supplied total_price/deposit_amount/payment_status/inventory_status/stripe_session_id", async () => {
    const supabase = createMockSupabase({ from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } }, rpc: () => ({ data: 1600, error: null }) });

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
    const supabase = createMockSupabase({ from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } }, rpc: () => ({ data: 1600, error: null }) });
    await createBookingDraftTool({ supabase, data: { ...VALID_INPUT, source: "direct" }, idempotencyKey: KEY });
    const insertArgs = supabase.__tableCalls.orders.upsert.mock.calls[0][0];
    expect(insertArgs.source).toBe("agent");
  });

  test("sold-out inventory -> inventory_unavailable, no draft inserted", async () => {
    const supabase = createMockSupabase({ from: { ...SOLD_OUT_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } }, rpc: () => ({ data: 1600, error: null }) });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE);
    expect(supabase.__tableCalls.orders).toBeUndefined();
  });

  test("AGENT_BOOKING_TOKEN_SECRET missing -> fails closed BEFORE any database write", async () => {
    delete process.env.AGENT_BOOKING_TOKEN_SECRET;
    const supabase = createMockSupabase({ from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } }, rpc: () => ({ data: 1600, error: null }) });

    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.AGENT_AUTH_NOT_CONFIGURED);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("issues a booking_access_token that verifies against the final order_id", async () => {
    const supabase = createMockSupabase({ from: { ...AVAILABLE_INVENTORY, orders: { data: [INSERTED_ORDER_FIXTURE], error: null } }, rpc: () => ({ data: 1600, error: null }) });
    const result = await createBookingDraftTool({ supabase, data: VALID_INPUT, idempotencyKey: KEY });

    const { verifyBookingAccessToken } = require("../../../lib/agent/tokens/bookingAccessToken");
    const verified = verifyBookingAccessToken({ token: result.booking_access_token, order_id: result.order_id });
    expect(verified.ok).toBe(true);
  });
});
