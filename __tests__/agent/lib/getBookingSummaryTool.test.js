const { getBookingSummaryTool, SUMMARY_COLUMNS, computeSummaryHash } = require("../../../lib/agent/tools/getBookingSummary");
const { createMockSupabase } = require("../../helpers/mockSupabase");
const { AGENT_ERROR_CODES } = require("../../../lib/agent/errorCodes");

const ORDER_ROW = {
  order_id: "ORD-20260901-11111",
  start_date: "2026-09-01",
  end_date: "2026-09-01",
  car_model_id: "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca",
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

describe("getBookingSummaryTool", () => {
  test("never issues select('*') — always the fixed whitelist column list", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: ORDER_ROW, error: null } } });

    await getBookingSummaryTool({ supabase, order_id: ORDER_ROW.order_id });

    const selectArg = supabase.__tableCalls.orders.select.mock.calls[0][0];
    expect(selectArg).not.toBe("*");
    expect(selectArg.split(",").map((s) => s.trim()).sort()).toEqual([...SUMMARY_COLUMNS].sort());
  });

  test("output contains no PII fields (name/phone/email/wechat/remark/itinerary) even if the DB row happened to carry them", async () => {
    const rowWithExtraFields = { ...ORDER_ROW, name: "Zhang San", phone: "13800000000", email: "z@example.com", wechat: "zs_wx", remark: "note", itinerary: "day plan" };
    const supabase = createMockSupabase({ from: { orders: { data: rowWithExtraFields, error: null } } });

    const result = await getBookingSummaryTool({ supabase, order_id: ORDER_ROW.order_id });

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty("name");
    expect(result).not.toHaveProperty("phone");
    expect(result).not.toHaveProperty("email");
    expect(result).not.toHaveProperty("wechat");
    expect(result).not.toHaveProperty("remark");
    expect(result).not.toHaveProperty("itinerary");
  });

  test("output whitelist is exactly the required field set", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: ORDER_ROW, error: null } } });
    const result = await getBookingSummaryTool({ supabase, order_id: ORDER_ROW.order_id });

    expect(Object.keys(result).sort()).toEqual(
      [
        "ok",
        "order_id",
        "start_date",
        "end_date",
        "car_model_id",
        "driver_lang",
        "duration",
        "pax",
        "luggage",
        "departure_hotel",
        "end_hotel",
        "total_price",
        "deposit_amount",
        "balance_due",
        "currency",
        "payment_status",
        "inventory_status",
        "summary_hash",
      ].sort()
    );
  });

  test("order not found -> order_not_found", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: null, error: null } } });
    const result = await getBookingSummaryTool({ supabase, order_id: "ORD-NOPE" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.ORDER_NOT_FOUND);
  });

  test("database error -> internal_error, no detail leaked", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: null, error: { message: "connection refused: 10.0.0.9:5432" } } } });
    const result = await getBookingSummaryTool({ supabase, order_id: ORDER_ROW.order_id });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INTERNAL_ERROR);
    expect(JSON.stringify(result)).not.toMatch(/10\.0\.0\.9/);
  });

  describe("summary_hash", () => {
    test("is stable for identical core-field input", () => {
      const a = computeSummaryHash(ORDER_ROW);
      const b = computeSummaryHash({ ...ORDER_ROW });
      expect(a).toBe(b);
    });

    test("changes when a core field (start_date) changes", () => {
      const a = computeSummaryHash(ORDER_ROW);
      const b = computeSummaryHash({ ...ORDER_ROW, start_date: "2026-09-02" });
      expect(a).not.toBe(b);
    });

    test("changes when total_price changes", () => {
      const a = computeSummaryHash(ORDER_ROW);
      const b = computeSummaryHash({ ...ORDER_ROW, total_price: 2000 });
      expect(a).not.toBe(b);
    });

    test("changes when car_model_id changes", () => {
      const a = computeSummaryHash(ORDER_ROW);
      const b = computeSummaryHash({ ...ORDER_ROW, car_model_id: "82cf604f-e688-49fe-aecf-69894a01f6cb" });
      expect(a).not.toBe(b);
    });

    test("does NOT change when only payment_status/inventory_status change (status progression must not invalidate a content confirmation)", () => {
      const a = computeSummaryHash(ORDER_ROW);
      const b = computeSummaryHash({ ...ORDER_ROW, payment_status: "paid", inventory_status: "locked" });
      expect(a).toBe(b);
    });
  });
});
