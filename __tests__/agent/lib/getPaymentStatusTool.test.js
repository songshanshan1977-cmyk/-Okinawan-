const { getPaymentStatusTool, GET_PAYMENT_STATUS_COLUMNS } = require("../../../lib/agent/tools/getPaymentStatus");
const { createMockSupabase } = require("../../helpers/mockSupabase");
const { AGENT_ERROR_CODES } = require("../../../lib/agent/errorCodes");

const ORDER_ID = "ORD-20990901-55555";

describe("getPaymentStatusTool", () => {
  test("missing order_id -> invalid_request, zero database calls", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: null, error: null } } });
    const result = await getPaymentStatusTool({ supabase, order_id: undefined });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("order not found -> order_not_found", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: null, error: null } } });
    const result = await getPaymentStatusTool({ supabase, order_id: "ORD-NOPE" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.ORDER_NOT_FOUND);
  });

  test("lookup uses a fixed whitelist, never select('*')", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: { order_id: ORDER_ID, payment_status: "draft", inventory_status: "pending", inventory_locked: false }, error: null } } });
    await getPaymentStatusTool({ supabase, order_id: ORDER_ID });
    const selectArg = supabase.__tableCalls.orders.select.mock.calls[0][0];
    expect(selectArg).not.toBe("*");
    expect(selectArg).toBe(GET_PAYMENT_STATUS_COLUMNS.join(", "));
  });

  test("draft, not yet locked -> paid:false, inventory_locked:false", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: { order_id: ORDER_ID, payment_status: "draft", inventory_status: "pending", inventory_locked: false }, error: null } } });
    const result = await getPaymentStatusTool({ supabase, order_id: ORDER_ID });
    expect(result.ok).toBe(true);
    expect(result.payment_status).toBe("draft");
    expect(result.paid).toBe(false);
    expect(result.inventory_locked).toBe(false);
  });

  test("pending (Stripe session created, webhook not yet fired) -> paid:false", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: { order_id: ORDER_ID, payment_status: "pending", inventory_status: "pending", inventory_locked: false }, error: null } } });
    const result = await getPaymentStatusTool({ supabase, order_id: ORDER_ID });
    expect(result.paid).toBe(false);
  });

  test("paid (webhook already ran) -> paid:true, inventory_locked:true", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: { order_id: ORDER_ID, payment_status: "paid", inventory_status: "confirmed", inventory_locked: true }, error: null } } });
    const result = await getPaymentStatusTool({ supabase, order_id: ORDER_ID });
    expect(result.ok).toBe(true);
    expect(result.paid).toBe(true);
    expect(result.inventory_locked).toBe(true);
  });

  test("never returns PII or a raw stripe_session_id, even if present on the row (whitelist excludes them)", async () => {
    const supabase = createMockSupabase({
      from: {
        orders: {
          data: { order_id: ORDER_ID, payment_status: "paid", inventory_status: "confirmed", inventory_locked: true, name: "Zhang San", phone: "13800000000", stripe_session_id: "cs_should_not_leak" },
          error: null,
        },
      },
    });
    const result = await getPaymentStatusTool({ supabase, order_id: ORDER_ID });
    expect(Object.keys(result).sort()).toEqual(["ok", "order_id", "payment_status", "inventory_status", "inventory_locked", "paid"].sort());
    expect(result.name).toBeUndefined();
    expect(result.phone).toBeUndefined();
    expect(result.stripe_session_id).toBeUndefined();
  });

  test("database error -> internal_error, never leaks the raw error", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: null, error: { message: "db secret detail" } } } });
    const result = await getPaymentStatusTool({ supabase, order_id: ORDER_ID });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INTERNAL_ERROR);
    expect(JSON.stringify(result)).not.toMatch(/db secret detail/);
  });
});
