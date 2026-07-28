const { updateBookingDraftTool, ALLOWED_CHANGE_FIELDS, ORDER_MERGE_COLUMNS } = require("../../../lib/agent/tools/updateBookingDraft");
const { computeSummaryHash, HASHED_FIELDS } = require("../../../lib/agent/bookingSummary");
const { createMockSupabase } = require("../../helpers/mockSupabase");
const { AGENT_ERROR_CODES } = require("../../../lib/agent/errorCodes");

const CAR = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";

const CURRENT_ORDER = {
  order_id: "ORD-20990901-11111",
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

const AVAILABLE_INVENTORY = { inventory_rules_v2: { data: [{ date: "2099-09-01", remaining_qty_calc: 3 }], error: null } };
const SOLD_OUT_INVENTORY = { inventory_rules_v2: { data: [{ date: "2099-09-01", remaining_qty_calc: 0 }], error: null } };

function updatedRowFixture(overrides = {}) {
  return {
    order_id: CURRENT_ORDER.order_id,
    start_date: CURRENT_ORDER.start_date,
    end_date: CURRENT_ORDER.end_date,
    car_model_id: CURRENT_ORDER.car_model_id,
    driver_lang: CURRENT_ORDER.driver_lang,
    duration: CURRENT_ORDER.duration,
    pax: CURRENT_ORDER.pax,
    luggage: CURRENT_ORDER.luggage,
    departure_hotel: CURRENT_ORDER.departure_hotel,
    end_hotel: CURRENT_ORDER.end_hotel,
    total_price: 1600,
    deposit_amount: 500,
    payment_status: "draft",
    inventory_status: "pending",
    ...overrides,
  };
}

describe("updateBookingDraftTool — auth/shape are the route handler's job, this tool assumes order_id+hash+changes only", () => {
  test("missing order_id -> invalid_request, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: CURRENT_ORDER, error: null } } });
    const result = await updateBookingDraftTool({ supabase, order_id: undefined, expected_summary_hash: CURRENT_HASH, changes: {} });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("missing expected_summary_hash -> invalid_request, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: CURRENT_ORDER, error: null } } });
    const result = await updateBookingDraftTool({ supabase, order_id: CURRENT_ORDER.order_id, expected_summary_hash: undefined, changes: {} });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("changes is not a plain object (array) -> invalid_request, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: CURRENT_ORDER, error: null } } });
    const result = await updateBookingDraftTool({ supabase, order_id: CURRENT_ORDER.order_id, expected_summary_hash: CURRENT_HASH, changes: [] });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe("updateBookingDraftTool — order lookup & staleness gates", () => {
  test("order not found -> order_not_found", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: null, error: null } } });
    const result = await updateBookingDraftTool({ supabase, order_id: "ORD-NOPE", expected_summary_hash: CURRENT_HASH, changes: {} });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.ORDER_NOT_FOUND);
  });

  test("order lookup uses a fixed whitelist, never select('*')", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: CURRENT_ORDER, error: null } } });
    await updateBookingDraftTool({ supabase, order_id: CURRENT_ORDER.order_id, expected_summary_hash: CURRENT_HASH, changes: {} });
    const selectArg = supabase.__tableCalls.orders.select.mock.calls[0][0];
    expect(selectArg).not.toBe("*");
  });

  test("payment_status is 'paid' -> paid_order_immutable, no write", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: { ...CURRENT_ORDER, payment_status: "paid" }, error: null } } });
    const result = await updateBookingDraftTool({ supabase, order_id: CURRENT_ORDER.order_id, expected_summary_hash: CURRENT_HASH, changes: { remark: "x" } });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.PAID_ORDER_IMMUTABLE);
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
  });

  test("payment_status 'pending' is still editable", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [{ data: { ...CURRENT_ORDER, payment_status: "pending" }, error: null }, { data: [updatedRowFixture({ payment_status: "pending" })], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });
    const result = await updateBookingDraftTool({ supabase, order_id: CURRENT_ORDER.order_id, expected_summary_hash: CURRENT_HASH, changes: { remark: "note" } });
    expect(result.ok).toBe(true);
  });

  test("stale expected_summary_hash -> 409 summary_stale, no write", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: CURRENT_ORDER, error: null } } });
    const result = await updateBookingDraftTool({ supabase, order_id: CURRENT_ORDER.order_id, expected_summary_hash: "a-stale-hash-value", changes: { remark: "x" } });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.SUMMARY_STALE);
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
  });
});

describe("updateBookingDraftTool — changes whitelist", () => {
  const FORBIDDEN_FIELDS = ["total_price", "deposit_amount", "payment_status", "inventory_status", "stripe_session_id", "agent_summary_confirmed_hash", "agent_summary_confirmed_at", "order_id", "source"];

  test.each(FORBIDDEN_FIELDS)("changes.%s present -> invalid_request, no write", async (field) => {
    const supabase = createMockSupabase({ from: { orders: { data: CURRENT_ORDER, error: null } } });
    const result = await updateBookingDraftTool({ supabase, order_id: CURRENT_ORDER.order_id, expected_summary_hash: CURRENT_HASH, changes: { [field]: "attacker-supplied" } });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
  });

  test("an entirely unknown key in changes is also rejected", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: CURRENT_ORDER, error: null } } });
    const result = await updateBookingDraftTool({ supabase, order_id: CURRENT_ORDER.order_id, expected_summary_hash: CURRENT_HASH, changes: { not_a_real_field: 1 } });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
  });

  test("ALLOWED_CHANGE_FIELDS matches exactly the documented business field set", () => {
    expect(ALLOWED_CHANGE_FIELDS.sort()).toEqual(
      ["start_date", "end_date", "car_model_id", "driver_lang", "duration", "pax", "luggage", "departure_hotel", "end_hotel", "name", "phone", "email", "wechat", "itinerary", "remark"].sort()
    );
  });
});

describe("updateBookingDraftTool — successful update", () => {
  test("only changes the fields present in `changes`, server recomputes price, deposit stays 500, confirmation fields cleared", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [{ data: CURRENT_ORDER, error: null }, { data: [updatedRowFixture({ end_hotel: "Hotel C" })], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await updateBookingDraftTool({ supabase, order_id: CURRENT_ORDER.order_id, expected_summary_hash: CURRENT_HASH, changes: { end_hotel: "Hotel C" } });

    expect(result.ok).toBe(true);
    expect(result.updated).toBe(true);
    expect(result.confirmed).toBe(false);
    expect(result.end_hotel).toBe("Hotel C");
    expect(result.total_price).toBe(1600);
    expect(result.deposit_amount).toBe(500);

    const updatePayload = supabase.__tableCalls.orders.update.mock.calls[0][0];
    expect(updatePayload.end_hotel).toBe("Hotel C");
    expect(updatePayload.start_date).toBe(CURRENT_ORDER.start_date); // unchanged field carried forward
    expect(updatePayload.deposit_amount).toBe(500);
    expect(updatePayload.agent_summary_confirmed_hash).toBeNull();
    expect(updatePayload.agent_summary_confirmed_at).toBeNull();
    expect(updatePayload).not.toHaveProperty("payment_status");
    expect(updatePayload).not.toHaveProperty("order_id");
    expect(updatePayload).not.toHaveProperty("source");
  });

  test("external total_price/deposit_amount/status in changes never reach the write, even alongside a legitimate field", async () => {
    // Only a legitimate field survives validation — the forbidden ones would
    // already have triggered invalid_request (see the whitelist describe
    // block above); this test additionally confirms a request containing
    // ONLY legitimate fields never independently re-derives price/deposit
    // from anything other than the server-side recompute.
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [{ data: CURRENT_ORDER, error: null }, { data: [updatedRowFixture({ pax: 3 })], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    await updateBookingDraftTool({ supabase, order_id: CURRENT_ORDER.order_id, expected_summary_hash: CURRENT_HASH, changes: { pax: 3 } });

    const updatePayload = supabase.__tableCalls.orders.update.mock.calls[0][0];
    expect(updatePayload.total_price).toBe(1600); // from the RPC mock, not from any client input
    expect(updatePayload.deposit_amount).toBe(500);
  });

  test("sold-out inventory after the change -> inventory_unavailable, no write", async () => {
    const supabase = createMockSupabase({
      from: { ...SOLD_OUT_INVENTORY, orders: { data: CURRENT_ORDER, error: null } },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await updateBookingDraftTool({ supabase, order_id: CURRENT_ORDER.order_id, expected_summary_hash: CURRENT_HASH, changes: { end_date: "2099-09-05" } });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE);
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
  });

  test("merged content that fails strict validation (bad email) -> invalid_request, no write", async () => {
    const supabase = createMockSupabase({ from: { ...AVAILABLE_INVENTORY, orders: { data: CURRENT_ORDER, error: null } }, rpc: () => ({ data: 1600, error: null }) });

    const result = await updateBookingDraftTool({ supabase, order_id: CURRENT_ORDER.order_id, expected_summary_hash: CURRENT_HASH, changes: { email: "not-an-email" } });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
  });

  test("output contains no PII (name/phone/email/wechat/remark/itinerary)", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [{ data: CURRENT_ORDER, error: null }, { data: [updatedRowFixture()], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await updateBookingDraftTool({ supabase, order_id: CURRENT_ORDER.order_id, expected_summary_hash: CURRENT_HASH, changes: {} });

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty("name");
    expect(result).not.toHaveProperty("phone");
    expect(result).not.toHaveProperty("email");
    expect(result).not.toHaveProperty("wechat");
    expect(result).not.toHaveProperty("remark");
    expect(result).not.toHaveProperty("itinerary");
  });

  test("update's own SELECT-back also never uses select('*')", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [{ data: CURRENT_ORDER, error: null }, { data: [updatedRowFixture()], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    await updateBookingDraftTool({ supabase, order_id: CURRENT_ORDER.order_id, expected_summary_hash: CURRENT_HASH, changes: {} });

    const secondSelectArg = supabase.__tableCalls.orders.select.mock.calls[1][0];
    expect(secondSelectArg).not.toBe("*");
  });

  test("unexpected update response shape (no rows) -> update_failed, not a crash", async () => {
    const supabase = createMockSupabase({
      from: { ...AVAILABLE_INVENTORY, orders: [{ data: CURRENT_ORDER, error: null }, { data: [], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await updateBookingDraftTool({ supabase, order_id: CURRENT_ORDER.order_id, expected_summary_hash: CURRENT_HASH, changes: {} });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.UPDATE_FAILED);
  });
});

describe("regression: ORDER_MERGE_COLUMNS must cover every HASHED_FIELDS field", () => {
  test("invariant: every field computeSummaryHash reads is present in the pre-read column whitelist", () => {
    // If this ever regresses (a HASHED_FIELDS field added to
    // lib/agent/bookingSummary.js without a matching addition here),
    // computeSummaryHash(currentOrder) inside updateBookingDraftTool would
    // silently hash `undefined` for the missing field(s) against a real
    // Supabase response (which honors the select() column list) — this
    // test fails loudly instead.
    for (const field of HASHED_FIELDS) {
      expect(ORDER_MERGE_COLUMNS).toContain(field);
    }
  });

  test("real-shape regression: a pre-read row containing ONLY the ORDER_MERGE_COLUMNS fields (exactly what a real Supabase select() returns, not a bigger fixture object) still matches the customer's just-seen summary_hash — update proceeds, never summary_stale", async () => {
    // Deliberately built to contain EXACTLY ORDER_MERGE_COLUMNS's fields and
    // nothing else, so this test cannot pass by accident the way the
    // existing queue-based mock's full-fixture passthrough could mask a
    // missing column (the mock does not filter by the select() column
    // list the way a real Supabase client does).
    const realisticSelectShapedRow = {};
    for (const col of ORDER_MERGE_COLUMNS) {
      realisticSelectShapedRow[col] = CURRENT_ORDER[col];
    }
    expect(Object.keys(realisticSelectShapedRow).sort()).toEqual([...ORDER_MERGE_COLUMNS].sort());

    // The hash the customer's prior get_booking_summary call actually
    // showed them — computed from the FULL, correct order content
    // (CURRENT_HASH, defined at the top of this file from CURRENT_ORDER
    // directly), completely independent of whatever ORDER_MERGE_COLUMNS
    // happens to select. This is the critical part: if ORDER_MERGE_COLUMNS
    // were missing a HASHED_FIELDS column, `realisticSelectShapedRow`
    // above would silently lack that field, the tool's internal
    // computeSummaryHash(currentOrder) would diverge from CURRENT_HASH,
    // and this test would correctly fail with summary_stale — exactly the
    // real bug this regression test catches.
    const expectedSummaryHash = CURRENT_HASH;

    const supabase = createMockSupabase({
      from: {
        ...AVAILABLE_INVENTORY,
        orders: [{ data: realisticSelectShapedRow, error: null }, { data: [updatedRowFixture({ remark: "updated" })], error: null }],
      },
      rpc: () => ({ data: 1600, error: null }),
    });

    const result = await updateBookingDraftTool({
      supabase,
      order_id: CURRENT_ORDER.order_id,
      expected_summary_hash: expectedSummaryHash,
      changes: { remark: "updated" },
    });

    expect(result.code).not.toBe(AGENT_ERROR_CODES.SUMMARY_STALE);
    expect(result.ok).toBe(true);
    expect(result.updated).toBe(true);
  });
});
