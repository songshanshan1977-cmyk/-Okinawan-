// __tests__/api/stripe-webhook.test.js
//
// Covers the Node-orchestration slice of both review rounds' scenario
// lists (the original 30 from round 1, plus the 26 required by the R2
// blocking-fix instructions). SQL-only mechanics — row-level locking, the
// 23-hour dead_letter sweep's actual timing, generate_series day coverage,
// the unique indexes, SECURITY DEFINER/REVOKE/GRANT enforcement — are NOT
// executable here (no local Postgres/psql/docker) and are instead covered
// by __tests__/sql/migrationStatic.test.js plus manual review. Every test
// below scripts the FOUR RPCs' (process_checkout_payment_v1,
// claim_webhook_notification_v1, freeze_webhook_notification_payload_v1,
// complete_webhook_notification_v1) responses the way they are documented
// to behave, and verifies Node's HTTP status mapping, freeze/send/complete
// orchestration, Resend Idempotency-Key usage, and log scrubbing around
// those responses.
//
// NOTE ON "86 original tests continue to pass" (R2 §十一 item 25): the
// complete_webhook_notification_v1 contract itself changed (boolean
// p_success -> 3-way p_outcome) and a mandatory freeze step was inserted
// between claim and send — so the LITERAL test code from the R1 round
// cannot be byte-identical (it mocked an interface that no longer exists).
// What is preserved is every SCENARIO the R1 tests exercised: this file
// re-implements each of them against the new contract, so the same
// observable behaviors (HTTP status codes, which emails get attempted,
// idempotent redelivery, partial-failure retry-only-the-failed-half) are
// still verified end to end.

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

function claimRow({ dedupeKey, notificationType, audience, claimToken, orderId }) {
  return {
    dedupe_key: dedupeKey,
    notification_type: notificationType,
    audience: audience || (notificationType.startsWith("customer") ? "customer" : "ops"),
    claim_token: claimToken,
    order_id: orderId,
  };
}

function successClaimRows(orderId, sessionId = "cs_test_1") {
  return [
    claimRow({ dedupeKey: `${orderId}:${sessionId}:customer:customer_booking_confirmed`, notificationType: "customer_booking_confirmed", claimToken: "tok-c-1", orderId }),
    claimRow({ dedupeKey: `${orderId}:${sessionId}:ops:ops_booking_confirmed`, notificationType: "ops_booking_confirmed", claimToken: "tok-o-1", orderId }),
  ];
}

function pendingClaimRows(orderId, sessionId = "cs_test_1") {
  return [
    claimRow({ dedupeKey: `${orderId}:${sessionId}:customer:customer_manual_review`, notificationType: "customer_manual_review", claimToken: "tok-c-1", orderId }),
    claimRow({ dedupeKey: `${orderId}:${sessionId}:ops:ops_manual_review`, notificationType: "ops_manual_review", claimToken: "tok-o-1", orderId }),
  ];
}

// Default freeze behavior: first-writer-wins simulation — echoes back
// exactly the candidate content Node just built, as the real RPC would on
// a row's first-ever freeze. Tests exercising "retry re-sends the ALREADY
// frozen content" override this to return a DIFFERENT payload than the
// candidate, so the assertion can tell the two apart.
function echoFreeze(args) {
  return {
    data: {
      ok: true,
      frozen: {
        recipient_email: args.p_recipient_email,
        subject: args.p_email_subject,
        html: args.p_email_html,
      },
    },
    error: null,
  };
}

function okComplete() {
  return { data: { ok: true }, error: null };
}

function rpcRouter({ processCheckoutPayment, claim, freeze, complete }) {
  return jest.fn((name, args) => {
    if (name === "process_checkout_payment_v1") return processCheckoutPayment(args);
    if (name === "claim_webhook_notification_v1") return (claim || (() => ({ data: [], error: null })))(args);
    if (name === "freeze_webhook_notification_payload_v1") return (freeze || echoFreeze)(args);
    if (name === "complete_webhook_notification_v1") return (complete || okComplete)(args);
    throw new Error("unexpected rpc name: " + name);
  });
}

function lockedResult(orderId, extra = {}) {
  return { data: { result: "locked", reason: null, order_id: orderId, inventory_status: "locked", ...extra }, error: null };
}

describe("HTTP-boundary scenarios (1-5 of the original list)", () => {
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

describe("core RPC error paths -> 500, nothing claimed", () => {
  test.each([
    ["order_not_found", { message: "process_checkout_payment_v1: order_not_found: ORD-X", code: "P0002" }],
    ["temporary DB failure", { message: "connection timeout", code: "57014" }],
    ["NULL/blank stripe_session_id rejected by the RPC guard", { message: "process_checkout_payment_v1: p_stripe_session_id is required", code: "P0003" }],
  ])("%s -> 500, no claim attempted", async (_label, rpcError) => {
    const supabase = createMockSupabase({ rpc: rpcRouter({ processCheckoutPayment: () => ({ data: null, error: rpcError }) }) });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({});
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "processing_failed" });
    expect(resendSend).not.toHaveBeenCalled();
    expect(supabase.rpc.mock.calls.filter((c) => c[0] === "claim_webhook_notification_v1").length).toBe(0);
  });
});

describe("successful payment -> claim, freeze, send with idempotencyKey, complete", () => {
  test("7/15. first-time success -> locked, both rows sent with the outbox row's own dedupe_key as Idempotency-Key, 200", async () => {
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
          return lockedResult(orderRow.order_id);
        },
        claim: (args) => {
          expect(args).toEqual({ p_order_id: orderRow.order_id, p_stripe_session_id: "cs_test_1" });
          return { data: successClaimRows(orderRow.order_id), error: null };
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

    // 4. every send carries the outbox row's own stable dedupe_key as the
    // Resend Idempotency-Key, as the SECOND argument (real per-call option).
    const rows = successClaimRows(orderRow.order_id);
    resendSend.mock.calls.forEach((call, i) => {
      expect(call[1]).toEqual({ idempotencyKey: rows[i].dedupe_key });
    });

    // 6. customer and ops rows get DIFFERENT keys.
    expect(resendSend.mock.calls[0][1].idempotencyKey).not.toBe(resendSend.mock.calls[1][1].idempotencyKey);

    // freeze called with the same dedupe_key + claim_token pairing as claim handed out.
    const freezeCalls = supabase.rpc.mock.calls.filter((c) => c[0] === "freeze_webhook_notification_payload_v1");
    expect(freezeCalls.length).toBe(2);
    expect(freezeCalls[0][1].p_dedupe_key).toBe(rows[0].dedupe_key);
    expect(freezeCalls[0][1].p_claim_token).toBe(rows[0].claim_token);

    // complete called with outcome:'sent' and a real provider_message_id.
    const completeCalls = supabase.rpc.mock.calls.filter((c) => c[0] === "complete_webhook_notification_v1");
    expect(completeCalls.every((c) => c[1].p_outcome === "sent" && c[1].p_provider_message_id)).toBe(true);
  });
});

describe("7/8. payload freeze: first-time vs retry (R2 §三)", () => {
  test("first claim of a row freezes the candidate content Node just built", async () => {
    const orderRow = { ...BASE_ORDER };
    let seenFreezeArgs = null;
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
        claim: () => ({ data: [successClaimRows(orderRow.order_id)[0]], error: null }),
        freeze: (args) => {
          seenFreezeArgs = args;
          return echoFreeze(args);
        },
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    await runHandler(handler, {});

    expect(seenFreezeArgs.p_recipient_email).toBe(orderRow.email);
    expect(seenFreezeArgs.p_email_subject).toContain("预约确认");
    // sent content matches the frozen (== just-built, first time) payload
    expect(resendSend.mock.calls[0][0].subject).toBe(seenFreezeArgs.p_email_subject);
  });

  test("8. retry (row already frozen with DIFFERENT content than order data would now produce) sends the FROZEN content, not a freshly rebuilt one", async () => {
    const orderRow = { ...BASE_ORDER, total_price: 9999 }; // order data has since "changed"
    const alreadyFrozen = { recipient_email: "frozen@example.com", subject: "FROZEN SUBJECT — do not rebuild", html: "<p>frozen html</p>" };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "already_processed", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        claim: () => ({ data: [successClaimRows(orderRow.order_id)[0]], error: null }),
        freeze: () => ({ data: { ok: true, frozen: alreadyFrozen }, error: null }), // simulates "already frozen" — discards Node's candidate
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    await runHandler(handler, {});

    expect(resendSend.mock.calls[0][0]).toEqual({
      from: expect.any(String),
      to: alreadyFrozen.recipient_email,
      subject: alreadyFrozen.subject,
      html: alreadyFrozen.html,
    });
  });

  test("9. freeze with a stale/expired claim_token -> overall failure, no send attempted", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
        claim: () => ({ data: [successClaimRows(orderRow.order_id)[0]], error: null }),
        freeze: () => ({ data: { ok: false, reason: "claim_token_mismatch_or_expired" }, error: null }),
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

describe("R2-B01 (§一): every complete_webhook_notification_v1 result is strictly validated", () => {
  test("1. complete resolves {ok:false} -> overall 500, never a silent 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
        claim: () => ({ data: [successClaimRows(orderRow.order_id)[0]], error: null }),
        complete: () => ({ data: { ok: false, reason: "claim_token_mismatch_or_expired" }, error: null }),
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "notification_delivery_failed" });
  });

  test("2. complete resolves {data:null,error:null} -> overall 500", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
        claim: () => ({ data: [successClaimRows(orderRow.order_id)[0]], error: null }),
        complete: () => ({ data: null, error: null }),
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test("3. complete resolves with a top-level error -> overall 500", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
        claim: () => ({ data: [successClaimRows(orderRow.order_id)[0]], error: null }),
        complete: () => ({ data: null, error: { message: "connection reset", details: "pgbouncer timeout", hint: "retry" } }),
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test("complete resolves with data.ok being a truthy non-boolean (unknown/malformed structure) -> still treated as failure", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
        claim: () => ({ data: [successClaimRows(orderRow.order_id)[0]], error: null }),
        complete: () => ({ data: { ok: "yes" }, error: null }), // not literal boolean true
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe("R2-B03 (§五): unknown notification_type, missing recipients", () => {
  test("12. unknown notification_type -> Resend never called, complete outcome='failed'/unknown_notification_type, 5xx, never marked sent", async () => {
    const orderRow = { ...BASE_ORDER };
    const completeArgs = [];
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
        claim: () => ({ data: [claimRow({ dedupeKey: "x:y:z:mystery", notificationType: "mystery_type", audience: "customer", claimToken: "tok-1", orderId: orderRow.order_id })], error: null }),
        complete: (args) => {
          completeArgs.push(args);
          return okComplete();
        },
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(resendSend).not.toHaveBeenCalled();
    expect(completeArgs[0].p_outcome).toBe("failed");
    expect(completeArgs[0].p_error_message).toBe("unknown_notification_type");
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test("13/14. customer missing email -> dead_letter/missing_customer_email, not sent; matching ops alert still sends; overall 200", async () => {
    const orderRow = { ...BASE_ORDER, email: null };
    const completeArgs = [];
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "failed", reason: "failed_no_stock", order_id: orderRow.order_id, inventory_status: "failed" }, error: null }),
        claim: () => ({ data: pendingClaimRows(orderRow.order_id), error: null }), // customer_manual_review + ops_manual_review
        complete: (args) => {
          completeArgs.push(args);
          return okComplete();
        },
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    // only ops sent (customer has no email to send to)
    expect(resendSend).toHaveBeenCalledTimes(1);
    const customerComplete = completeArgs.find((a) => a.p_dedupe_key.includes("customer"));
    const opsComplete = completeArgs.find((a) => a.p_dedupe_key.includes("ops"));
    expect(customerComplete.p_outcome).toBe("dead_letter");
    expect(customerComplete.p_error_message).toBe("missing_customer_email");
    expect(opsComplete.p_outcome).toBe("sent");
    // 15. customer dead_letter does NOT force a 5xx by itself — ops still succeeded.
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("customer missing email never gets an infinite-retry 5xx purely because of the missing address (bounded: dead_letter is terminal, not failed)", async () => {
    const orderRow = { ...BASE_ORDER, email: null };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "failed", reason: "failed_no_stock", order_id: orderRow.order_id, inventory_status: "failed" }, error: null }),
        // only the customer row claimable this time (ops already sent earlier)
        claim: () => ({ data: [pendingClaimRows(orderRow.order_id)[0]], error: null }),
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(resendSend).not.toHaveBeenCalled();
  });

  test("15. ops recipient missing (structurally forced via a notificationContent override, since OPS_EMAIL_TO always has a hardcoded fallback in real code) -> outcome='failed'/missing_ops_recipient, 5xx, not sent", async () => {
    const orderRow = { ...BASE_ORDER };
    const completeArgs = [];
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
        claim: () => ({ data: [claimRow({ dedupeKey: "x:y:ops:ops_booking_confirmed", notificationType: "ops_booking_confirmed", audience: "ops", claimToken: "tok-1", orderId: orderRow.order_id })], error: null }),
        complete: (args) => {
          completeArgs.push(args);
          return okComplete();
        },
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({
      supabase,
      constructEvent: alwaysReturnEvent(event),
      resendSend,
      notificationContentOverride: ({ notificationType }) => {
        if (notificationType === "ops_booking_confirmed") return { mail: { subject: "x", html: "y" }, to: null };
        return null;
      },
    });
    const res = await runHandler(handler, {});

    expect(resendSend).not.toHaveBeenCalled();
    expect(completeArgs[0].p_outcome).toBe("failed");
    expect(completeArgs[0].p_error_message).toBe("missing_ops_recipient");
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test("16. an empty-string provider message id from Resend is treated as failure, never lets a row reach 'sent'", async () => {
    const orderRow = { ...BASE_ORDER };
    const completeArgs = [];
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
        claim: () => ({ data: [successClaimRows(orderRow.order_id)[0]], error: null }),
        complete: (args) => {
          completeArgs.push(args);
          return okComplete();
        },
      }),
    });
    const resendSend = jest.fn(() => Promise.resolve({ data: { id: "" }, error: null }));
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(completeArgs[0].p_outcome).toBe("failed");
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe("R2 §六/§七: same Session bound to a different order -> ops-only conflict alert (17, 18)", () => {
  test("17. duplicate_payment_conflict/session_order_conflict -> claim scoped to the ATTEMPTED order+session, ops conflict email sent with both order ids, no customer email, 200", async () => {
    const orderRow = { ...BASE_ORDER, order_id: "ORD-ATTEMPTED" };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: (args) => {
          expect(args.p_order_id).toBe("ORD-ATTEMPTED");
          return {
            data: {
              result: "duplicate_payment_conflict",
              reason: "session_order_conflict",
              order_id: "ORD-ATTEMPTED",
              inventory_status: "pending",
              existing_order_id: "ORD-EXISTING",
            },
            error: null,
          };
        },
        claim: (args) => {
          expect(args).toEqual({ p_order_id: "ORD-ATTEMPTED", p_stripe_session_id: "cs_test_1" });
          return {
            data: [claimRow({ dedupeKey: "cs_test_1:ORD-ATTEMPTED:ops:session_order_conflict", notificationType: "ops_session_order_conflict", audience: "ops", claimToken: "tok-1", orderId: "ORD-ATTEMPTED" })],
            error: null,
          };
        },
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: "ORD-ATTEMPTED" });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(resendSend).toHaveBeenCalledTimes(1);
    const mail = resendSend.mock.calls[0][0];
    expect(mail.html).toContain("ORD-ATTEMPTED");
    expect(mail.html).toContain("ORD-EXISTING");
    expect(mail.subject).not.toContain("预约确认");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("18. repeated delivery of the same conflicting session -> claim finds nothing left to send (already 'sent'), no duplicate outbox, 200", async () => {
    const orderRow = { ...BASE_ORDER, order_id: "ORD-ATTEMPTED" };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({
          data: { result: "duplicate_payment_conflict", reason: "session_order_conflict", order_id: "ORD-ATTEMPTED", inventory_status: "pending", existing_order_id: "ORD-EXISTING" },
          error: null,
        }),
        claim: () => ({ data: [], error: null }), // already sent -> nothing claimable
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: "ORD-ATTEMPTED" });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(resendSend).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe("10/11. dead-letter observable boundary at the Node layer (SQL timing itself is DB INTEGRATION UNVERIFIED)", () => {
  test("row still within the auto-retry window -> claim returns it normally and it gets processed", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "already_processed", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        claim: () => ({ data: [successClaimRows(orderRow.order_id)[0]], error: null }),
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("row past the 23h cutoff -> claim has already swept it to dead_letter and returns nothing for it; Node does not error, does not resend, 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "already_processed", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        claim: () => ({ data: [], error: null }), // simulates: row was dead-lettered by the sweep, not claimable
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});
    expect(resendSend).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe("idempotent redelivery / order_id source conflict (original scenarios 8, 9, 10, 14, 22, 26, 27)", () => {
  test("8/9/22. exact redelivery, nothing left claimable -> no re-send, 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "already_processed", reason: "stripe_session_id_already_recorded_for_this_order", order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        claim: () => ({ data: [], error: null }),
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
  });

  test("14a. order_id source disagreement, exactly one resolvable -> RPC called with p_id_source_conflict=true, pending+urgent sent, 200", async () => {
    const orderRow = { ...BASE_ORDER, order_id: "ORD-REAL" };
    const supabase = createMockSupabase({
      from: {
        orders: [{ data: [{ order_id: "ORD-REAL" }], error: null }, { data: orderRow, error: null }],
      },
      rpc: rpcRouter({
        processCheckoutPayment: (args) => {
          expect(args.p_id_source_conflict).toBe(true);
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

  test("14b. order_id source disagreement, unresolvable -> 500, no RPC call, no writes", async () => {
    const supabase = createMockSupabase({ from: { orders: [{ data: [], error: null }] } });
    const resendSend = okResend();
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const event = fakeCheckoutSessionCompletedEvent({ orderId: "ORD-A", clientReferenceId: "ORD-B" });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(500);
    expect(supabase.rpc).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  test("27. failed outcome redelivered after both rows already sent -> no re-send, 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "already_processed", reason: "failed_no_stock", order_id: orderRow.order_id, inventory_status: "failed" }, error: null }),
        claim: () => ({ data: [], error: null }),
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});
    expect(resendSend).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe("payment validation mismatches (original 11, 12, 13) and inventory failures (17, 18)", () => {
  test.each([
    ["amount too low", "amount_mismatch"],
    ["currency mismatch", "currency_mismatch"],
    ["mid-range day sold out", "failed_no_stock"],
    ["mid-range day missing inventory row", "failed_missing_inventory"],
  ])("%s -> failed, pending+urgent, 200", async (_label, reason) => {
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
    const opsMail = resendSend.mock.calls.find((c) => c[0].to !== orderRow.email)[0];
    expect(opsMail.html).toContain(reason);
  });
});

describe("partial failure then targeted retry (original 15/23/24/25)", () => {
  test("customer succeeds, ops fails -> 500 first attempt; retry only re-sends ops, 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const rows = successClaimRows(orderRow.order_id);
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }, { data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: jest
          .fn()
          .mockReturnValueOnce(lockedResult(orderRow.order_id))
          .mockReturnValueOnce({ data: { result: "already_processed", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        claim: jest
          .fn()
          .mockReturnValueOnce({ data: rows, error: null }) // call1: both claimable
          .mockReturnValueOnce({ data: [rows[1]], error: null }), // call2: only ops still claimable
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
    // retry uses the SAME idempotencyKey as the first (failed) attempt for that row.
    expect(resendSend.mock.calls[1][1].idempotencyKey).toBe(resendSend.mock.calls[2][1].idempotencyKey);
  });
});

describe("R2-B05/N-01/N-02 (§七): log scrubbing — every console.* argument checked, not just the first", () => {
  test("19. full session.id / event.id never appear anywhere in logs, only their masked digests", async () => {
    const orderRow = { ...BASE_ORDER };
    const fullSessionId = "cs_test_FULLSECRETSESSIONID1234567890abcdef";
    const fullEventId = "evt_FULLSECRETEVENTID1234567890abcdef";
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
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

    // 7. inspect EVERY argument of EVERY console.* call, not just call[0].
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

  test("20. a raw Supabase error object (message/details/hint) never reaches any console.* argument, on every RPC failure path", async () => {
    const dangerousError = {
      message: "duplicate key value violates unique constraint",
      details: "Key (dedupe_key)=(ORD-1:cs_1:customer:x) already exists.",
      hint: "check the send_logs table",
      code: "23505",
    };
    const orderRow = { ...BASE_ORDER };

    // core RPC failure
    const scenarios = [
      {
        label: "core RPC error",
        supabase: createMockSupabase({ rpc: rpcRouter({ processCheckoutPayment: () => ({ data: null, error: dangerousError }) }) }),
      },
      {
        label: "claim RPC error",
        supabase: createMockSupabase({
          from: { orders: [{ data: orderRow, error: null }] },
          rpc: rpcRouter({ processCheckoutPayment: () => lockedResult(orderRow.order_id), claim: () => ({ data: null, error: dangerousError }) }),
        }),
      },
      {
        label: "freeze RPC error",
        supabase: createMockSupabase({
          from: { orders: [{ data: orderRow, error: null }] },
          rpc: rpcRouter({
            processCheckoutPayment: () => lockedResult(orderRow.order_id),
            claim: () => ({ data: [successClaimRows(orderRow.order_id)[0]], error: null }),
            freeze: () => ({ data: null, error: dangerousError }),
          }),
        }),
      },
      {
        label: "complete RPC error",
        supabase: createMockSupabase({
          from: { orders: [{ data: orderRow, error: null }] },
          rpc: rpcRouter({
            processCheckoutPayment: () => lockedResult(orderRow.order_id),
            claim: () => ({ data: [successClaimRows(orderRow.order_id)[0]], error: null }),
            complete: () => ({ data: null, error: dangerousError }),
          }),
        }),
      },
    ];

    for (const scenario of scenarios) {
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
      const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
      const handler = loadWebhookHandler({ supabase: scenario.supabase, constructEvent: alwaysReturnEvent(event), resendSend: okResend() });
      await runHandler(handler, {});

      const allLoggedText = [...errorSpy.mock.calls, ...infoSpy.mock.calls]
        .flat()
        .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
        .join("\n");

      expect(allLoggedText).not.toContain(dangerousError.message);
      expect(allLoggedText).not.toContain(dangerousError.details);
      expect(allLoggedText).not.toContain(dangerousError.hint);
      expect(allLoggedText).not.toContain("23505");

      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  test("provider send failure: the resend error message is NOT logged to console (it still goes to the DB via complete's p_error_message, which is a separate, acceptable channel)", async () => {
    const orderRow = { ...BASE_ORDER };
    const secretySendError = "rate limited: account abc123@resend.com exceeded quota, retry-after=60";
    const completeArgs = [];
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
        claim: () => ({ data: [successClaimRows(orderRow.order_id)[0]], error: null }),
        complete: (args) => {
          completeArgs.push(args);
          return okComplete();
        },
      }),
    });
    const resendSend = jest.fn(() => Promise.resolve({ data: null, error: { message: secretySendError } }));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    await runHandler(handler, {});

    const loggedText = errorSpy.mock.calls.flat().map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("\n");
    expect(loggedText).not.toContain(secretySendError);
    // it DOES reach the DB-facing complete() call — that's the intended channel.
    expect(completeArgs[0].p_error_message).toContain("rate limited");
    errorSpy.mockRestore();
  });
});

describe("outer catch never returns 200 and never leaks exception detail (original 28)", () => {
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

  test("unknown/unexpected core RPC result shape -> 500, not silently 200", async () => {
    const supabase = createMockSupabase({ rpc: rpcRouter({ processCheckoutPayment: () => ({ data: { result: "something_new_and_unhandled" }, error: null }) }) });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({});
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(500);
    expect(resendSend).not.toHaveBeenCalled();
  });

  test("claim_webhook_notification_v1 itself erroring -> 500, no send attempted", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({ processCheckoutPayment: () => lockedResult(orderRow.order_id), claim: () => ({ data: null, error: { message: "claim rpc exploded" } }) }),
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
  test("claim returns an empty array", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({ processCheckoutPayment: () => lockedResult(orderRow.order_id), claim: () => ({ data: [], error: null }) }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(resendSend).not.toHaveBeenCalled();
  });
});

describe("9. Node no longer reads/writes orders.email_customer_sent / email_ops_sent as decision inputs", () => {
  test("select() for notification content does not request the legacy boolean flags", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../../pages/api/stripe-webhook.js"), "utf8");
    expect(src).not.toMatch(/email_customer_sent/);
    expect(src).not.toMatch(/email_ops_sent/);
  });
});
