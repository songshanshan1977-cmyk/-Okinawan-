const { confirmBookingSummaryTool } = require("../../../lib/agent/tools/confirmBookingSummary");
const { computeSummaryHash } = require("../../../lib/agent/bookingSummary");
const { createMockSupabase } = require("../../helpers/mockSupabase");
const { AGENT_ERROR_CODES } = require("../../../lib/agent/errorCodes");

const CAR = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";

const ORDER_ROW = {
  order_id: "ORD-20990901-22222",
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
  agent_summary_confirmed_hash: null,
  agent_summary_confirmed_at: null,
};

const CURRENT_HASH = computeSummaryHash(ORDER_ROW);

describe("confirmBookingSummaryTool — request shape", () => {
  test("missing order_id -> invalid_request, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: ORDER_ROW, error: null } } });
    const result = await confirmBookingSummaryTool({ supabase, order_id: undefined, summary_hash: CURRENT_HASH });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("missing summary_hash -> invalid_request, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: ORDER_ROW, error: null } } });
    const result = await confirmBookingSummaryTool({ supabase, order_id: ORDER_ROW.order_id, summary_hash: undefined });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe("confirmBookingSummaryTool — lookup gates", () => {
  test("order not found -> order_not_found", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: null, error: null } } });
    const result = await confirmBookingSummaryTool({ supabase, order_id: "ORD-NOPE", summary_hash: CURRENT_HASH });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.ORDER_NOT_FOUND);
  });

  test("lookup never uses select('*')", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: ORDER_ROW, error: null } } });
    await confirmBookingSummaryTool({ supabase, order_id: ORDER_ROW.order_id, summary_hash: CURRENT_HASH });
    const selectArg = supabase.__tableCalls.orders.select.mock.calls[0][0];
    expect(selectArg).not.toBe("*");
  });

  test("paid order -> paid_order_immutable, no write", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: { ...ORDER_ROW, payment_status: "paid" }, error: null } } });
    const result = await confirmBookingSummaryTool({ supabase, order_id: ORDER_ROW.order_id, summary_hash: CURRENT_HASH });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.PAID_ORDER_IMMUTABLE);
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
  });

  test("stale summary_hash (does not match current DB content) -> 409 summary_stale, no write", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: ORDER_ROW, error: null } } });
    const result = await confirmBookingSummaryTool({ supabase, order_id: ORDER_ROW.order_id, summary_hash: "a-stale-hash" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.SUMMARY_STALE);
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
  });
});

describe("confirmBookingSummaryTool — first-time confirmation", () => {
  test("current hash + never confirmed before -> persists both columns together, returns confirmed_at", async () => {
    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: ORDER_ROW, error: null },
          { data: [{ agent_summary_confirmed_hash: CURRENT_HASH, agent_summary_confirmed_at: "2099-09-01T00:00:00.000Z" }], error: null },
        ],
      },
    });

    const result = await confirmBookingSummaryTool({ supabase, order_id: ORDER_ROW.order_id, summary_hash: CURRENT_HASH });

    expect(result.ok).toBe(true);
    expect(result.confirmed).toBe(true);
    expect(result.order_id).toBe(ORDER_ROW.order_id);
    expect(result.summary_hash).toBe(CURRENT_HASH);
    expect(typeof result.confirmed_at).toBe("string");

    const updatePayload = supabase.__tableCalls.orders.update.mock.calls[0][0];
    expect(updatePayload.agent_summary_confirmed_hash).toBe(CURRENT_HASH);
    expect(typeof updatePayload.agent_summary_confirmed_at).toBe("string");
  });

  test("output never contains PII or any business/price field", async () => {
    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: ORDER_ROW, error: null },
          { data: [{ agent_summary_confirmed_hash: CURRENT_HASH, agent_summary_confirmed_at: "2099-09-01T00:00:00.000Z" }], error: null },
        ],
      },
    });

    const result = await confirmBookingSummaryTool({ supabase, order_id: ORDER_ROW.order_id, summary_hash: CURRENT_HASH });

    expect(Object.keys(result).sort()).toEqual(["ok", "confirmed", "order_id", "summary_hash", "confirmed_at"].sort());
  });

  test("never writes to any business/price/payment field", async () => {
    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: ORDER_ROW, error: null },
          { data: [{ agent_summary_confirmed_hash: CURRENT_HASH, agent_summary_confirmed_at: "2099-09-01T00:00:00.000Z" }], error: null },
        ],
      },
    });

    await confirmBookingSummaryTool({ supabase, order_id: ORDER_ROW.order_id, summary_hash: CURRENT_HASH });

    const updatePayload = supabase.__tableCalls.orders.update.mock.calls[0][0];
    expect(Object.keys(updatePayload).sort()).toEqual(["agent_summary_confirmed_hash", "agent_summary_confirmed_at"].sort());
  });
});

describe("confirmBookingSummaryTool — idempotent replay", () => {
  test("same hash already confirmed -> returns the ORIGINAL confirmed_at, does not re-write", async () => {
    const alreadyConfirmed = { ...ORDER_ROW, agent_summary_confirmed_hash: CURRENT_HASH, agent_summary_confirmed_at: "2099-09-01T00:00:00.000Z" };
    const supabase = createMockSupabase({ from: { orders: { data: alreadyConfirmed, error: null } } });

    const result = await confirmBookingSummaryTool({ supabase, order_id: ORDER_ROW.order_id, summary_hash: CURRENT_HASH });

    expect(result.ok).toBe(true);
    expect(result.confirmed).toBe(true);
    expect(result.confirmed_at).toBe("2099-09-01T00:00:00.000Z");
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled(); // no re-write at all
  });
});
