// __tests__/api/stripe-webhook.test.js
//
// Covers the Node-orchestration slice of both the original 30-scenario
// list and the 21 new scenarios required by the Codex Draft-PR-#2
// blocking-fix round (B-01..B-05). SQL-only mechanics of
// process_checkout_payment_v1 / claim_webhook_notification_v1 /
// complete_webhook_notification_v1 (row-level locking, generate_series day
// coverage, the two new unique indexes, SECURITY DEFINER/REVOKE/GRANT
// enforcement) are NOT executable here — no local Postgres/psql/docker is
// available — and are instead covered by __tests__/sql/migrationStatic.test.js
// (text-level static checks) plus manual review. Every test below scripts
// the three RPCs' responses the way they are documented to behave, and
// verifies Node's HTTP status mapping, notification-outbox orchestration,
// Resend response validation, and log masking around those responses.

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
};

function okResend() {
  return jest.fn(() => Promise.resolve({ data: { id: "mock-email-id" }, error: null }));
}

function alwaysReturnEvent(event) {
  return jest.fn(() => event);
}

async function runHandler(handler, reqOpts) {
  const req = createMockReq(reqOpts);
  const res = createMockRes();
  await handler(req, res);
  return res;
}

function claimRow({ dedupeKey, notificationType, audience = notificationType.startsWith("customer") ? "customer" : "ops", claimToken, orderId }) {
  return { dedupe_key: dedupeKey, notification_type: notificationType, audience, claim_token: claimToken, order_id: orderId };
}

function successClaimRows(orderId) {
  return [
    claimRow({ dedupeKey: `${orderId}:cs_test_1:customer:customer_booking_confirmed`, notificationType: "customer_booking_confirmed", claimToken: "tok-c-1", orderId }),
    claimRow({ dedupeKey: `${orderId}:cs_test_1:ops:ops_booking_confirmed`, notificationType: "ops_booking_confirmed", claimToken: "tok-o-1", orderId }),
  ];
}

function pendingClaimRows(orderId, sessionId = "cs_test_1") {
  return [
    claimRow({ dedupeKey: `${orderId}:${sessionId}:customer:customer_manual_review`, notificationType: "customer_manual_review", claimToken: "tok-c-1", orderId }),
    claimRow({ dedupeKey: `${orderId}:${sessionId}:ops:ops_manual_review`, notificationType: "ops_manual_review", claimToken: "tok-o-1", orderId }),
  ];
}

function rpcRouter({ processCheckoutPayment, claim, complete }) {
  return jest.fn((name, args) => {
    if (name === "process_checkout_payment_v1") return processCheckoutPayment(args);
    if (name === "claim_webhook_notification_v1") return (claim || (() => ({ data: [], error: null })))(args);
    if (name === "complete_webhook_notification_v1") return (complete || (() => ({ data: { ok: true }, error: null })))(args);
    throw new Error("unexpected rpc name: " + name);
  });
}

describe("stripe-webhook v1 — HTTP-boundary scenarios (1-5)", () => {
  test("1. non-POST method -> 405", async () => {
    const supabase = createMockSupabase({ rpc: () => ({ data: null, error: null }) });
    const handler = loadWebhookHandler({ supabase, constructEvent: jest.fn(), resendSend: okResend() });
    const res = await runHandler(handler, { method: "GET" });
    expect(res.status).toHaveBeenCalledWith(405);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test("2. signature verification failure -> 400", async () => {
    const supabase = createMockSupabase({});
    const constructEvent = jest.fn(() => {
      throw new Error("invalid signature");
    });
    const handler = loadWebhookHandler({ supabase, constructEvent, resendSend: okResend() });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith("Webhook Error");
  });

  test("3. unrelated event type -> 200, no DB calls", async () => {
    const supabase = createMockSupabase({});
    const event = { id: "evt_x", type: "customer.created", data: { object: {} } };
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend: okResend() });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("4. session.payment_status !== 'paid' -> 200, no writes", async () => {
    const supabase = createMockSupabase({});
    const event = fakeCheckoutSessionCompletedEvent({ paymentStatus: "unpaid" });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend: okResend() });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test("5. order_id completely missing -> 200, no writes", async () => {
    const supabase = createMockSupabase({});
    const event = fakeCheckoutSessionCompletedEvent({ orderId: null, clientReferenceId: undefined });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend: okResend() });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

describe("order lookup / core-RPC-error scenarios (order not found, temporary DB failure, NULL/blank session id)", () => {
  test.each([
    ["order_not_found", { message: "process_checkout_payment_v1: order_not_found: ORD-X", code: "P0002" }],
    ["temporary DB failure", { message: "connection timeout", code: "57014" }],
    ["18. NULL/blank stripe_session_id rejected by the RPC guard", { message: "process_checkout_payment_v1: p_stripe_session_id is required", code: "P0003" }],
  ])("%s -> 500, no notification claim attempted", async (_label, rpcError) => {
    const supabase = createMockSupabase({
      rpc: rpcRouter({ processCheckoutPayment: () => ({ data: null, error: rpcError }) }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({});
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "processing_failed" });
    expect(resendSend).not.toHaveBeenCalled();
    // claim RPC must never be called when the core RPC itself errored.
    const claimCalls = supabase.rpc.mock.calls.filter((c) => c[0] === "claim_webhook_notification_v1");
    expect(claimCalls.length).toBe(0);
  });
});

describe("successful payment -> outbox claim/send/complete (7, 15, 16)", () => {
  test("7/15. first-time success -> locked, claims 2 rows, both sent, both completed, 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: (args) => {
          expect(args).toEqual({
            p_order_id: orderRow.order_id,
            p_stripe_session_id: "cs_test_1",
            p_amount: 50000,
            p_currency: "cny",
            p_id_source_conflict: false,
          });
          return { data: { result: "locked", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null };
        },
        claim: (args) => {
          expect(args).toEqual({ p_order_id: orderRow.order_id, p_stripe_session_id: "cs_test_1" });
          return { data: successClaimRows(orderRow.order_id), error: null };
        },
        complete: (args) => {
          expect(args.p_success).toBe(true);
          expect(["tok-c-1", "tok-o-1"]).toContain(args.p_claim_token);
          return { data: { ok: true }, error: null };
        },
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, result: "locked" });
    expect(resendSend).toHaveBeenCalledTimes(2);
    const completeCalls = supabase.rpc.mock.calls.filter((c) => c[0] === "complete_webhook_notification_v1");
    expect(completeCalls.length).toBe(2);
  });
});

describe("idempotent redelivery (8, 9, 22)", () => {
  test("8/9/22. exact redelivery already_processed/locked, both outbox rows already 'sent' -> claim returns nothing, no re-send, 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({
          data: { result: "already_processed", reason: null, order_id: orderRow.order_id, inventory_status: "locked" },
          error: null,
        }),
        claim: () => ({ data: [], error: null }), // nothing claimable — both rows already 'sent'
      }),
    });
    const resendSend = okResend();

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
    const processCalls = supabase.rpc.mock.calls.filter((c) => c[0] === "process_checkout_payment_v1");
    expect(processCalls[0][1].p_stripe_session_id).toBe("cs_dup");
    expect(processCalls[1][1].p_stripe_session_id).toBe("cs_dup");
  });
});

describe("B-02: second real Stripe Session on an already-paid order (10, 6, 8-new-outbox)", () => {
  test("10/6/8. second, different session -> duplicate_payment_conflict; claim is called with the SECOND session's own id; pending+urgent sent; 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: (args) => {
          expect(args.p_stripe_session_id).toBe("cs_second");
          return {
            data: {
              result: "duplicate_payment_conflict",
              reason: "order_already_paid_by_different_session",
              order_id: orderRow.order_id,
              inventory_status: "locked", // first session already locked inventory
            },
            error: null,
          };
        },
        claim: (args) => {
          // B-02/B-08: the claim must be scoped to the SECOND session's own
          // id, so it picks up the independent manual-review outbox rows
          // that session created — not the first session's already-sent rows.
          expect(args.p_stripe_session_id).toBe("cs_second");
          return { data: pendingClaimRows(orderRow.order_id, "cs_second"), error: null };
        },
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id, sessionId: "cs_second" });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(resendSend).toHaveBeenCalledTimes(2);
    const subjects = resendSend.mock.calls.map((c) => c[0].subject);
    expect(subjects.some((s) => s.includes("等待确认"))).toBe(true);
    expect(subjects.some((s) => s.includes("需要立即处理"))).toBe(true);
  });
});

describe("payment validation mismatches (11, 12, 13)", () => {
  test.each([
    ["amount too low", "amount_mismatch"],
    ["amount too high", "amount_mismatch"],
    ["currency mismatch", "currency_mismatch"],
  ])("%s -> failed, pending+urgent emails, 200", async (_label, reason) => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "failed", reason, order_id: orderRow.order_id, inventory_status: "failed" }, error: null }),
        claim: () => ({ data: pendingClaimRows(orderRow.order_id), error: null }),
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(resendSend).toHaveBeenCalledTimes(2);
  });
});

describe("order_id source conflict (14)", () => {
  test("14a. disagree, exactly one resolvable -> RPC called with p_id_source_conflict=true", async () => {
    const orderRow = { ...BASE_ORDER, order_id: "ORD-REAL" };
    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: [{ order_id: "ORD-REAL" }], error: null }, // resolveOrderId existence check
          { data: orderRow, error: null }, // select for notification content
        ],
      },
      rpc: rpcRouter({
        processCheckoutPayment: (args) => {
          expect(args.p_id_source_conflict).toBe(true);
          expect(args.p_order_id).toBe("ORD-REAL");
          return { data: { result: "failed", reason: "order_id_source_mismatch", order_id: "ORD-REAL", inventory_status: "failed" }, error: null };
        },
        claim: () => ({ data: pendingClaimRows("ORD-REAL"), error: null }),
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: "ORD-REAL", clientReferenceId: "ORD-FAKE" });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(resendSend).toHaveBeenCalledTimes(2);
  });

  test("14b. disagree, unresolvable -> 500, security log, no RPC call, no writes", async () => {
    const supabase = createMockSupabase({ from: { orders: [{ data: [], error: null }] } });
    const resendSend = okResend();
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const event = fakeCheckoutSessionCompletedEvent({ orderId: "ORD-A", clientReferenceId: "ORD-B" });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "order_id_conflict" });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(resendSend).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe("inventory failure reasons (17, 18 of the original 30-list)", () => {
  test.each([
    ["mid-range day sold out", "failed_no_stock"],
    ["mid-range day missing inventory row", "failed_missing_inventory"],
  ])("%s -> failed, pending+urgent, 200; SQL logic itself is DB INTEGRATION UNVERIFIED", async (_label, reason) => {
    const orderRow = { ...BASE_ORDER, start_date: "2026-08-01", end_date: "2026-08-05" };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "failed", reason, order_id: orderRow.order_id, inventory_status: "failed" }, error: null }),
        claim: () => ({ data: pendingClaimRows(orderRow.order_id), error: null }),
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(resendSend).toHaveBeenCalledTimes(2);
    const opsMail = resendSend.mock.calls.find((c) => c[0].to !== orderRow.email)[0];
    expect(opsMail.html).toContain(reason);
  });
});

describe("B-03: Resend response validation (10, 11, 12 of the new list)", () => {
  test("10. Resend resolves with { data: null, error: {message} } -> treated as failure, complete(success=false), overall 500", async () => {
    const orderRow = { ...BASE_ORDER };
    const completeArgsSeen = [];
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "locked", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        claim: () => ({ data: successClaimRows(orderRow.order_id), error: null }),
        complete: (args) => {
          completeArgsSeen.push(args);
          return { data: { ok: true }, error: null };
        },
      }),
    });
    const resendSend = jest.fn(() => Promise.resolve({ data: null, error: { message: "rate limited" } }));
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(500);
    expect(completeArgsSeen.every((a) => a.p_success === false)).toBe(true);
    expect(completeArgsSeen.every((a) => a.p_error_message && a.p_error_message.includes("rate limited"))).toBe(true);
  });

  test("11. Resend resolves with { data: null, error: null } -> treated as failure (no message id, no error either)", async () => {
    const orderRow = { ...BASE_ORDER };
    const completeArgsSeen = [];
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "locked", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        claim: () => ({ data: successClaimRows(orderRow.order_id), error: null }),
        complete: (args) => {
          completeArgsSeen.push(args);
          return { data: { ok: true }, error: null };
        },
      }),
    });
    const resendSend = jest.fn(() => Promise.resolve({ data: null, error: null }));
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(500);
    expect(completeArgsSeen.every((a) => a.p_success === false)).toBe(true);
    expect(completeArgsSeen.every((a) => a.p_error_message === "resend_response_missing_message_id")).toBe(true);
  });

  test("12. Resend promise rejects -> treated as failure, overall 500", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "locked", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        claim: () => ({ data: successClaimRows(orderRow.order_id), error: null }),
      }),
    });
    const resendSend = jest.fn(() => Promise.reject(new Error("network down")));
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(500);
  });

  test("Resend returns a valid message id -> treated as success", async () => {
    const orderRow = { ...BASE_ORDER };
    const completeArgsSeen = [];
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "locked", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        claim: () => ({ data: successClaimRows(orderRow.order_id), error: null }),
        complete: (args) => {
          completeArgsSeen.push(args);
          return { data: { ok: true }, error: null };
        },
      }),
    });
    const resendSend = jest.fn(() => Promise.resolve({ data: { id: "re_abc123" }, error: null }));
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(completeArgsSeen.every((a) => a.p_success === true && a.p_provider_message_id === "re_abc123")).toBe(true);
  });
});

describe("B-04: claim recoverability across process interruption (13, 14)", () => {
  test("13. claim after expiry re-surfaces a 'processing'-turned-claimable row (simulated by the claim RPC returning it again)", async () => {
    const orderRow = { ...BASE_ORDER };
    let claimCallCount = 0;
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "already_processed", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        claim: () => {
          claimCallCount += 1;
          // Simulates: a prior process claimed this row and crashed before
          // sending; claim_expires_at has since lapsed, so the RPC's own
          // WHERE clause naturally re-surfaces it with a FRESH claim_token.
          return { data: [claimRow({ dedupeKey: `${orderRow.order_id}:cs_test_1:customer:customer_booking_confirmed`, notificationType: "customer_booking_confirmed", claimToken: `tok-retry-${claimCallCount}`, orderId: orderRow.order_id })], error: null };
        },
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(resendSend).toHaveBeenCalledTimes(1);
    const completeCall = supabase.rpc.mock.calls.find((c) => c[0] === "complete_webhook_notification_v1");
    expect(completeCall[1].p_claim_token).toBe("tok-retry-1");
  });

  test("14. Resend does not receive any idempotency-key parameter (installed SDK v3.5.0 has no such option) — documents the known crash-window limitation rather than guessing an unsupported param", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "locked", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        claim: () => ({ data: successClaimRows(orderRow.order_id), error: null }),
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    await runHandler(handler, {});

    resendSend.mock.calls.forEach((call) => {
      const payload = call[0];
      expect(Object.keys(payload).sort()).toEqual(["from", "html", "subject", "to"]);
      expect(call.length).toBe(1); // no second "options" argument carrying a header/idempotency key
    });
  });
});

describe("15. customer succeeds, ops fails -> retry only re-sends ops", () => {
  test("partial failure then targeted retry", async () => {
    const orderRow = { ...BASE_ORDER };
    const completeArgs = [];
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }, { data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: jest
          .fn()
          .mockReturnValueOnce({ data: { result: "locked", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null })
          .mockReturnValueOnce({ data: { result: "already_processed", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        claim: jest
          .fn()
          .mockReturnValueOnce({ data: successClaimRows(orderRow.order_id), error: null }) // call1: both claimable
          .mockReturnValueOnce({
            data: [claimRow({ dedupeKey: `${orderRow.order_id}:cs_test_1:ops:ops_booking_confirmed`, notificationType: "ops_booking_confirmed", claimToken: "tok-o-2", orderId: orderRow.order_id })],
            error: null,
          }), // call2: only the ops row is still claimable (customer's is 'sent')
        complete: (args) => {
          completeArgs.push(args);
          return { data: { ok: true }, error: null };
        },
      }),
    });

    const resendSend = jest
      .fn()
      .mockImplementationOnce(() => Promise.resolve({ data: { id: "customer-1" }, error: null })) // call1 customer -> ok
      .mockImplementationOnce(() => Promise.reject(new Error("resend down"))) // call1 ops -> fails
      .mockImplementationOnce(() => Promise.resolve({ data: { id: "ops-retry" }, error: null })); // call2 ops retry -> ok

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

describe("B-05: no full Session ID / Event ID / PII in logs (17 of the new list)", () => {
  test("full session.id never appears in any console.* call across the whole request lifecycle", async () => {
    const orderRow = { ...BASE_ORDER };
    const fullSessionId = "cs_test_FULLSECRETSESSIONID1234567890abcdef";
    const fullEventId = "evt_FULLSECRETEVENTID1234567890abcdef";
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "locked", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        claim: () => ({ data: successClaimRows(orderRow.order_id), error: null }),
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ id: fullEventId, sessionId: fullSessionId, orderId: orderRow.order_id });

    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    await runHandler(handler, {});

    const allLoggedText = [...infoSpy.mock.calls, ...errorSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join("\n");

    expect(allLoggedText).not.toContain(fullSessionId);
    expect(allLoggedText).not.toContain(fullEventId);
    expect(allLoggedText).not.toContain(orderRow.email);
    expect(allLoggedText).not.toContain(orderRow.phone);

    infoSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  test("full session.id never appears in logs on the RPC-error 500 path either", async () => {
    const fullSessionId = "cs_test_FULLSECRETSESSIONID1234567890abcdef";
    const supabase = createMockSupabase({
      rpc: rpcRouter({ processCheckoutPayment: () => ({ data: null, error: { message: "connection timeout" } }) }),
    });
    const event = fakeCheckoutSessionCompletedEvent({ sessionId: fullSessionId });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend: okResend() });
    await runHandler(handler, {});

    const allLoggedText = errorSpy.mock.calls
      .flat()
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join("\n");
    expect(allLoggedText).not.toContain(fullSessionId);
    errorSpy.mockRestore();
  });
});

describe("9. Node no longer reads/writes orders.email_customer_sent / email_ops_sent as decision inputs", () => {
  test("select() for notification content does not request the legacy boolean flags", async () => {
    // Static proxy: read the handler's source and confirm it never
    // references these columns anywhere (they may still exist in the DB
    // for back-office backward-compat, written only by
    // complete_webhook_notification_v1 itself — never read or written by
    // this file directly).
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../../pages/api/stripe-webhook.js"), "utf8");
    expect(src).not.toMatch(/email_customer_sent/);
    expect(src).not.toMatch(/email_ops_sent/);
  });
});

describe("outer catch never returns 200 and never leaks exception detail (28 of the original list)", () => {
  test("unexpected exception -> 500, generic body only, no leaked detail", async () => {
    const supabase = createMockSupabase({});
    supabase.from = jest.fn(() => {
      throw new Error("unexpected: table connection pool exhausted at 10.0.0.5 with secret=abc123");
    });
    const event = fakeCheckoutSessionCompletedEvent({ orderId: "ORD-A", clientReferenceId: "ORD-B" });
    const resendSend = okResend();
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "internal_error" });
    const jsonArg = JSON.stringify(res.json.mock.calls[res.json.mock.calls.length - 1][0]);
    expect(jsonArg).not.toContain("secret=abc123");
    consoleErrorSpy.mockRestore();
  });

  test("unknown/unexpected RPC result shape -> 500, not silently 200", async () => {
    const supabase = createMockSupabase({
      rpc: rpcRouter({ processCheckoutPayment: () => ({ data: { result: "something_new_and_unhandled" }, error: null }) }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({});
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "unexpected_rpc_result" });
    expect(resendSend).not.toHaveBeenCalled();
  });

  test("claim_webhook_notification_v1 itself erroring -> 500, no send attempted", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "locked", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        claim: () => ({ data: null, error: { message: "claim rpc exploded" } }),
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(500);
    expect(resendSend).not.toHaveBeenCalled();
  });
});

describe("no outstanding notifications claimed -> still 200 with zero send attempts", () => {
  test("claim returns an empty array (nothing pending/failed/expired)", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "locked", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        claim: () => ({ data: [], error: null }),
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(resendSend).not.toHaveBeenCalled();
  });
});
