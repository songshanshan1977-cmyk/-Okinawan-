// __tests__/api/stripe-webhook.test.js
//
// Covers the Node-orchestration slice of the 30 scenarios required by the
// v9 sandbox instructions (§十). The SQL-only mechanics of
// process_checkout_payment_v1 (generate_series day coverage, FOR UPDATE
// locking granularity, the payments.stripe_session_id unique index itself)
// are NOT executable here — no local Postgres/psql/docker is available in
// this environment — and are instead covered by manual static review of
// supabase/migrations/20260722120000_webhook_fail_safe_v1.sql. Every test
// below scripts the RPC's `{result, reason, inventory_status}` response the
// way the real RPC is documented to produce it, and verifies that Node's
// HTTP status mapping, email-template selection and retry-safety around
// that response are correct. See the round's final report for the full
// scenario-to-test-type mapping (§8 / §12 of the required output format).

const { createMockSupabase } = require("../helpers/mockSupabase");
const { createMockReq, createMockRes } = require("../helpers/mockReqRes");
const { loadWebhookHandler, fakeCheckoutSessionCompletedEvent } = require("../helpers/webhookHarness");

const BASE_ORDER = {
  order_id: "ORD-20260722-11111",
  start_date: "2026-08-01",
  end_date: "2026-08-01",
  car_model_id: "453df662-d350-4ab9-b811-61ffcda40d4b",
  driver_lang: "ZH",
  duration: 8,
  email: "customer@example.com",
  name: "Zhang San",
  phone: "13800000000",
  wechat: "zhangsan_wx",
  total_price: 1600,
  deposit_amount: 500,
  balance_due: 1100,
  email_customer_sent: false,
  email_ops_sent: false,
};

function okResend() {
  return jest.fn(() => Promise.resolve({ id: "mock-email-id" }));
}

function alwaysThrowingConstructEvent(event) {
  return jest.fn(() => event);
}

async function runHandler(handler, reqOpts) {
  const req = createMockReq(reqOpts);
  const res = createMockRes();
  await handler(req, res);
  return res;
}

describe("stripe-webhook v1 fail-safe — HTTP-boundary scenarios (1-5)", () => {
  test("1. non-POST method -> 405", async () => {
    const supabase = createMockSupabase({});
    const handler = loadWebhookHandler({
      supabase,
      constructEvent: jest.fn(),
      resendSend: okResend(),
    });
    const res = await runHandler(handler, { method: "GET" });
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.end).toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test("2. signature verification failure -> 400, body 'Webhook Error'", async () => {
    const supabase = createMockSupabase({});
    const constructEvent = jest.fn(() => {
      throw new Error("invalid signature");
    });
    const handler = loadWebhookHandler({ supabase, constructEvent, resendSend: okResend() });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith("Webhook Error");
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test("3. unrelated event type -> 200, no DB writes", async () => {
    const supabase = createMockSupabase({});
    const event = { id: "evt_x", type: "customer.created", data: { object: {} } };
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysThrowingConstructEvent(event), resendSend: okResend() });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("4. session.payment_status !== 'paid' -> 200, no writes", async () => {
    const supabase = createMockSupabase({});
    const event = fakeCheckoutSessionCompletedEvent({ paymentStatus: "unpaid" });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysThrowingConstructEvent(event), resendSend: okResend() });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("5. order_id completely missing (no metadata, no client_reference_id) -> 200, no writes", async () => {
    const supabase = createMockSupabase({});
    const event = fakeCheckoutSessionCompletedEvent({ orderId: null, clientReferenceId: undefined });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysThrowingConstructEvent(event), resendSend: okResend() });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe("stripe-webhook v1 fail-safe — order lookup / RPC-error scenarios (6, 20, 21)", () => {
  test.each([
    ["order_not_found (RAISE from RPC)", { message: "process_checkout_payment_v1: order_not_found: ORD-X", code: "P0002" }],
    ["temporary DB/RPC failure", { message: "connection timeout", code: "57014" }],
  ])("6/20/21. %s -> 500, no partial writes, no emails", async (_label, rpcError) => {
    const supabase = createMockSupabase({
      from: {}, // any .from() call in this scenario is itself a bug — throws if reached
      rpc: () => ({ data: null, error: rpcError }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({});
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysThrowingConstructEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "processing_failed" });
    expect(supabase.from).not.toHaveBeenCalled(); // no partial order/email writes attempted
    expect(resendSend).not.toHaveBeenCalled();
  });
});

describe("stripe-webhook v1 fail-safe — successful payment (7, 15, 16)", () => {
  test("7/15. first-time success -> locked, both success emails sent, 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: orderRow, error: null }, // select for email content
          { data: [{ order_id: orderRow.order_id }], error: null }, // customer claim
          { data: [{ order_id: orderRow.order_id }], error: null }, // ops claim
        ],
      },
      rpc: (name, args) => {
        expect(name).toBe("process_checkout_payment_v1");
        expect(args).toEqual({
          p_order_id: orderRow.order_id,
          p_stripe_session_id: "cs_test_1",
          p_amount: 50000,
          p_currency: "cny",
          p_id_source_conflict: false,
        });
        return { data: { result: "locked", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null };
      },
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysThrowingConstructEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, result: "locked" });
    expect(resendSend).toHaveBeenCalledTimes(2);
    const subjects = resendSend.mock.calls.map((c) => c[0].subject);
    expect(subjects.some((s) => s.includes("预约确认"))).toBe(true);
    expect(subjects.some((s) => s.includes("新订单"))).toBe(true);
  });

  test("16. multi-day order -> Node passes session fields through unchanged, RPC owns date math", async () => {
    const orderRow = { ...BASE_ORDER, start_date: "2026-08-01", end_date: "2026-08-04" };
    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: orderRow, error: null },
          { data: [{ order_id: orderRow.order_id }], error: null },
          { data: [{ order_id: orderRow.order_id }], error: null },
        ],
      },
      rpc: jest.fn(() => ({
        data: { result: "locked", reason: null, order_id: orderRow.order_id, inventory_status: "locked" },
        error: null,
      })),
    });
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id, amountTotal: 50000, currency: "cny" });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysThrowingConstructEvent(event), resendSend: okResend() });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(supabase.rpc).toHaveBeenCalledWith(
      "process_checkout_payment_v1",
      expect.objectContaining({ p_amount: 50000, p_currency: "cny" })
    );
  });
});

describe("stripe-webhook v1 fail-safe — idempotent redelivery (8, 9, 22)", () => {
  test("8/9/22. exact redelivery already_processed/locked, both flags already true -> no re-send, 200", async () => {
    const orderRow = { ...BASE_ORDER, email_customer_sent: true, email_ops_sent: true };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: jest.fn(() => ({
        data: { result: "already_processed", reason: "stripe_session_id_already_recorded_for_this_order", order_id: orderRow.order_id, inventory_status: "locked" },
        error: null,
      })),
    });
    const resendSend = okResend();

    // Two deliveries: same session.id, different event.id (Stripe can redeliver
    // the same event under a new delivery attempt, or send a logically
    // duplicate event) — Node keys everything off session.id, not event.id.
    const handler = loadWebhookHandler({
      supabase,
      constructEvent: jest
        .fn()
        .mockReturnValueOnce(fakeCheckoutSessionCompletedEvent({ id: "evt_1", sessionId: "cs_dup", orderId: orderRow.order_id }))
        .mockReturnValueOnce(fakeCheckoutSessionCompletedEvent({ id: "evt_2", sessionId: "cs_dup", orderId: orderRow.order_id })),
      resendSend,
    });

    const res1 = await runHandler(handler, {});
    const res2 = await runHandler(handler, {});

    expect(res1.status).toHaveBeenCalledWith(200);
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(resendSend).not.toHaveBeenCalled();
    expect(supabase.rpc.mock.calls[0][1].p_stripe_session_id).toBe("cs_dup");
    expect(supabase.rpc.mock.calls[1][1].p_stripe_session_id).toBe("cs_dup");
  });
});

describe("stripe-webhook v1 fail-safe — deterministic conflicts (10, 26)", () => {
  test("10/26. second, different session for an already-paid order -> duplicate_payment_conflict, pending+urgent emails, 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: orderRow, error: null },
          { data: [{ order_id: orderRow.order_id }], error: null },
          { data: [{ order_id: orderRow.order_id }], error: null },
        ],
      },
      rpc: jest.fn(() => ({
        data: {
          result: "duplicate_payment_conflict",
          reason: "order_already_paid_by_different_session",
          order_id: orderRow.order_id,
          inventory_status: "locked", // the FIRST payment already locked inventory
        },
        error: null,
      })),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id, sessionId: "cs_second" });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysThrowingConstructEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(resendSend).toHaveBeenCalledTimes(2);
    const subjects = resendSend.mock.calls.map((c) => c[0].subject);
    // duplicate_payment_conflict must NOT get the "booking confirmed" template
    // even though inventory_status reads "locked" from the earlier session.
    expect(subjects.some((s) => s.includes("等待确认"))).toBe(true);
    expect(subjects.some((s) => s.includes("需要立即处理"))).toBe(true);
  });
});

describe("stripe-webhook v1 fail-safe — payment validation mismatches (11, 12, 13)", () => {
  test.each([
    ["amount too low", "amount_mismatch"],
    ["amount too high", "amount_mismatch"],
    ["currency mismatch", "currency_mismatch"],
  ])("11/12/13. %s -> failed, pending+urgent emails, 200 (money already captured by Stripe)", async (_label, reason) => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: orderRow, error: null },
          { data: [{ order_id: orderRow.order_id }], error: null },
          { data: [{ order_id: orderRow.order_id }], error: null },
        ],
      },
      rpc: jest.fn(() => ({
        data: { result: "failed", reason, order_id: orderRow.order_id, inventory_status: "failed" },
        error: null,
      })),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysThrowingConstructEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(resendSend).toHaveBeenCalledTimes(2);
  });
});

describe("stripe-webhook v1 fail-safe — order_id source conflict (14)", () => {
  test("14a. metadata.order_id vs client_reference_id disagree, exactly one resolvable -> RPC called with p_id_source_conflict=true", async () => {
    const orderRow = { ...BASE_ORDER, order_id: "ORD-REAL" };
    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: [{ order_id: "ORD-REAL" }], error: null }, // resolveOrderId existence check
          { data: orderRow, error: null }, // select for email
          { data: [{ order_id: orderRow.order_id }], error: null }, // customer claim
          { data: [{ order_id: orderRow.order_id }], error: null }, // ops claim
        ],
      },
      rpc: jest.fn((name, args) => {
        expect(args.p_id_source_conflict).toBe(true);
        expect(args.p_order_id).toBe("ORD-REAL");
        return {
          data: { result: "failed", reason: "order_id_source_mismatch", order_id: "ORD-REAL", inventory_status: "failed" },
          error: null,
        };
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: "ORD-REAL", clientReferenceId: "ORD-FAKE" });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysThrowingConstructEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(resendSend).toHaveBeenCalledTimes(2);
  });

  test("14b. metadata.order_id vs client_reference_id disagree, unresolvable -> 500, security log, no RPC call, no writes", async () => {
    const supabase = createMockSupabase({
      from: { orders: [{ data: [], error: null }] }, // neither candidate exists
    });
    const resendSend = okResend();
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const event = fakeCheckoutSessionCompletedEvent({ orderId: "ORD-A", clientReferenceId: "ORD-B" });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysThrowingConstructEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "order_id_conflict" });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(resendSend).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe("stripe-webhook v1 fail-safe — inventory failure reasons surfaced by the RPC (17, 18)", () => {
  test.each([
    ["mid-range day sold out", "failed_no_stock"],
    ["mid-range day missing inventory row", "failed_missing_inventory"],
  ])("17/18. %s -> failed, pending+urgent emails, 200; DB INTEGRATION UNVERIFIED for the SQL logic itself", async (_label, reason) => {
    const orderRow = { ...BASE_ORDER, start_date: "2026-08-01", end_date: "2026-08-05" };
    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: orderRow, error: null },
          { data: [{ order_id: orderRow.order_id }], error: null },
          { data: [{ order_id: orderRow.order_id }], error: null },
        ],
      },
      rpc: jest.fn(() => ({
        data: { result: "failed", reason, order_id: orderRow.order_id, inventory_status: "failed" },
        error: null,
      })),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysThrowingConstructEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(resendSend).toHaveBeenCalledTimes(2);
    const opsMail = resendSend.mock.calls.find((c) => c[0].to !== orderRow.email)[0];
    expect(opsMail.html).toContain(reason);
  });
});

describe("stripe-webhook v1 fail-safe — email delivery failure forces 5xx so Stripe retries (23, 24, 25)", () => {
  test("23. customer email fails, ops succeeds -> 500 first attempt; retry only re-sends customer, 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const rolledBackOrder = { ...orderRow, email_customer_sent: false, email_ops_sent: true };

    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: orderRow, error: null }, // call1: select for email
          { data: [{ order_id: orderRow.order_id }], error: null }, // call1: customer claim
          { data: null, error: null }, // call1: customer claim rollback (send failed)
          { data: [{ order_id: orderRow.order_id }], error: null }, // call1: ops claim
          { data: rolledBackOrder, error: null }, // call2: select for email
          { data: [{ order_id: orderRow.order_id }], error: null }, // call2: customer claim (retry)
        ],
      },
      rpc: jest
        .fn()
        .mockReturnValueOnce({ data: { result: "locked", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null })
        .mockReturnValueOnce({ data: { result: "already_processed", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
    });

    const resendSend = jest
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error("resend down"))) // call1 customer -> fails
      .mockImplementationOnce(() => Promise.resolve({ id: "ops-1" })) // call1 ops -> succeeds
      .mockImplementationOnce(() => Promise.resolve({ id: "customer-retry" })); // call2 customer retry -> succeeds

    const handler = loadWebhookHandler({
      supabase,
      constructEvent: jest.fn(() => fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id })),
      resendSend,
    });

    const res1 = await runHandler(handler, {});
    expect(res1.status).toHaveBeenCalledWith(500);
    expect(res1.json).toHaveBeenCalledWith({ error: "email_delivery_failed" });

    const res2 = await runHandler(handler, {});
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(resendSend).toHaveBeenCalledTimes(3);
  });

  test("24. ops email fails, customer succeeds -> 500 first attempt; retry only re-sends ops, 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const rolledBackOrder = { ...orderRow, email_customer_sent: true, email_ops_sent: false };

    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: orderRow, error: null },
          { data: [{ order_id: orderRow.order_id }], error: null }, // customer claim
          { data: [{ order_id: orderRow.order_id }], error: null }, // ops claim
          { data: null, error: null }, // ops claim rollback
          { data: rolledBackOrder, error: null }, // call2 select
          { data: [{ order_id: orderRow.order_id }], error: null }, // call2 ops claim retry
        ],
      },
      rpc: jest
        .fn()
        .mockReturnValueOnce({ data: { result: "locked", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null })
        .mockReturnValueOnce({ data: { result: "already_processed", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
    });

    const resendSend = jest
      .fn()
      .mockImplementationOnce(() => Promise.resolve({ id: "customer-1" })) // call1 customer -> ok
      .mockImplementationOnce(() => Promise.reject(new Error("resend down"))) // call1 ops -> fails
      .mockImplementationOnce(() => Promise.resolve({ id: "ops-retry" })); // call2 ops retry -> ok

    const handler = loadWebhookHandler({
      supabase,
      constructEvent: jest.fn(() => fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id })),
      resendSend,
    });

    const res1 = await runHandler(handler, {});
    expect(res1.status).toHaveBeenCalledWith(500);

    const res2 = await runHandler(handler, {});
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(resendSend).toHaveBeenCalledTimes(3);
  });
});

describe("stripe-webhook v1 fail-safe — failed/conflict outcomes are also idempotent across redelivery (27)", () => {
  test("27. failed outcome redelivered after both emails already sent -> no re-send, 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const sentOrder = { ...orderRow, email_customer_sent: true, email_ops_sent: true };

    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: orderRow, error: null }, // call1 select
          { data: [{ order_id: orderRow.order_id }], error: null }, // call1 customer claim
          { data: [{ order_id: orderRow.order_id }], error: null }, // call1 ops claim
          { data: sentOrder, error: null }, // call2 select
        ],
      },
      rpc: jest
        .fn()
        .mockReturnValueOnce({ data: { result: "failed", reason: "failed_no_stock", order_id: orderRow.order_id, inventory_status: "failed" }, error: null })
        .mockReturnValueOnce({ data: { result: "already_processed", reason: "stripe_session_id_already_recorded_for_this_order", order_id: orderRow.order_id, inventory_status: "failed" }, error: null }),
    });

    const resendSend = okResend();
    const handler = loadWebhookHandler({
      supabase,
      constructEvent: jest.fn(() => fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id })),
      resendSend,
    });

    const res1 = await runHandler(handler, {});
    expect(res1.status).toHaveBeenCalledWith(200);
    expect(resendSend).toHaveBeenCalledTimes(2);

    const res2 = await runHandler(handler, {});
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(resendSend).toHaveBeenCalledTimes(2); // unchanged — nothing re-sent
  });
});

describe("stripe-webhook v1 fail-safe — outer catch never returns 200 and never leaks exception detail (28)", () => {
  test("28. unexpected exception in the handler body -> 500, generic body only", async () => {
    const supabase = createMockSupabase({});
    supabase.from = jest.fn(() => {
      throw new Error("unexpected: table connection pool exhausted at 10.0.0.5 with secret=abc123");
    });
    // Force the mismatch path so resolveOrderId reaches supabase.from().
    const event = fakeCheckoutSessionCompletedEvent({ orderId: "ORD-A", clientReferenceId: "ORD-B" });
    const resendSend = okResend();
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysThrowingConstructEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "internal_error" });
    const jsonArg = JSON.stringify(res.json.mock.calls[res.json.mock.calls.length - 1][0]);
    expect(jsonArg).not.toContain("secret=abc123");
    expect(jsonArg).not.toContain("10.0.0.5");
    consoleErrorSpy.mockRestore();
  });

  test("28b. unknown/unexpected RPC result shape -> 500, not silently 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: {},
      rpc: jest.fn(() => ({ data: { result: "something_new_and_unhandled" }, error: null })),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysThrowingConstructEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "unexpected_rpc_result" });
    expect(resendSend).not.toHaveBeenCalled();
  });
});
