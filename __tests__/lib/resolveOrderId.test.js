const { resolveOrderId, RESULT } = require("../../lib/webhook/resolveOrderId");
const { createMockSupabase } = require("../helpers/mockSupabase");

describe("resolveOrderId", () => {
  test("both absent -> MISSING", async () => {
    const supabase = createMockSupabase({});
    const r = await resolveOrderId({ supabase, metadataOrderId: null, clientReferenceId: null });
    expect(r).toEqual({ status: RESULT.MISSING, orderId: null });
  });

  test("only metadata.order_id present -> OK", async () => {
    const supabase = createMockSupabase({});
    const r = await resolveOrderId({ supabase, metadataOrderId: "ORD-A", clientReferenceId: null });
    expect(r).toEqual({ status: RESULT.OK, orderId: "ORD-A" });
  });

  test("only client_reference_id present -> OK", async () => {
    const supabase = createMockSupabase({});
    const r = await resolveOrderId({ supabase, metadataOrderId: null, clientReferenceId: "ORD-B" });
    expect(r).toEqual({ status: RESULT.OK, orderId: "ORD-B" });
  });

  test("both present and equal -> OK, no existence lookup performed", async () => {
    const supabase = createMockSupabase({});
    const r = await resolveOrderId({ supabase, metadataOrderId: "ORD-A", clientReferenceId: "ORD-A" });
    expect(r).toEqual({ status: RESULT.OK, orderId: "ORD-A" });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("both present, different, exactly metadata one exists -> RESOLVED_CONFLICT with metadata id", async () => {
    const supabase = createMockSupabase({
      from: { orders: { data: [{ order_id: "ORD-A" }], error: null } },
    });
    const r = await resolveOrderId({ supabase, metadataOrderId: "ORD-A", clientReferenceId: "ORD-B" });
    expect(r).toEqual({ status: RESULT.RESOLVED_CONFLICT, orderId: "ORD-A" });
  });

  test("both present, different, exactly client_reference_id one exists -> RESOLVED_CONFLICT with that id", async () => {
    const supabase = createMockSupabase({
      from: { orders: { data: [{ order_id: "ORD-B" }], error: null } },
    });
    const r = await resolveOrderId({ supabase, metadataOrderId: "ORD-A", clientReferenceId: "ORD-B" });
    expect(r).toEqual({ status: RESULT.RESOLVED_CONFLICT, orderId: "ORD-B" });
  });

  test("both present, different, BOTH exist as distinct real orders -> UNRESOLVABLE_CONFLICT", async () => {
    const supabase = createMockSupabase({
      from: { orders: { data: [{ order_id: "ORD-A" }, { order_id: "ORD-B" }], error: null } },
    });
    const r = await resolveOrderId({ supabase, metadataOrderId: "ORD-A", clientReferenceId: "ORD-B" });
    expect(r).toEqual({ status: RESULT.UNRESOLVABLE_CONFLICT, orderId: null });
  });

  test("both present, different, NEITHER exists -> UNRESOLVABLE_CONFLICT", async () => {
    const supabase = createMockSupabase({
      from: { orders: { data: [], error: null } },
    });
    const r = await resolveOrderId({ supabase, metadataOrderId: "ORD-A", clientReferenceId: "ORD-B" });
    expect(r).toEqual({ status: RESULT.UNRESOLVABLE_CONFLICT, orderId: null });
  });

  test("existence lookup itself errors -> UNRESOLVABLE_CONFLICT (safe default)", async () => {
    const supabase = createMockSupabase({
      from: { orders: { data: null, error: { message: "db timeout" } } },
    });
    const r = await resolveOrderId({ supabase, metadataOrderId: "ORD-A", clientReferenceId: "ORD-B" });
    expect(r).toEqual({ status: RESULT.UNRESOLVABLE_CONFLICT, orderId: null });
  });
});
