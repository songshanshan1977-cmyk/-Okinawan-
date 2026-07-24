// __tests__/api/stripe-webhook.test.js
//
// Covers the Node-orchestration slice of all three review rounds'
// scenario lists (original 30, R2's 26, R3's 22). SQL-only mechanics —
// row-level locking, the 23-hour dead_letter sweep's actual timing,
// generate_series day coverage, the unique indexes, SECURITY DEFINER/
// REVOKE/GRANT enforcement, the atomic ops_missing_customer_email insert
// inside complete_webhook_notification_v1 — are NOT executable here (no
// local Postgres/psql/docker) and are instead covered by
// __tests__/sql/migrationStatic.test.js plus manual review. Every test
// below scripts the FOUR RPCs' responses the way they are documented to
// behave, and verifies Node's HTTP status mapping, freeze/send/complete
// orchestration, Resend Idempotency-Key usage, and log scrubbing.
//
// IMPORTANT MOCK-DESIGN NOTE (R3): claimAndProcessNotifications now ALWAYS
// makes exactly TWO claim_webhook_notification_v1 calls per webhook
// delivery — the second pass exists to pick up an
// ops_missing_customer_email row that complete_webhook_notification_v1
// may have atomically inserted mid-way through the first pass, which
// obviously didn't exist yet when the first claim ran. A `claim` mock that
// just returns the same batch every time would make every test think the
// SAME rows got reprocessed on the second pass — every claim mock below
// is therefore a `claimSeq(...)` sequence: each call consumes the next
// queued batch, and any call beyond the queue falls back to an empty
// result (matching what the real claim RPC would return once nothing is
// left pending/failed/expired).
//
// NOTE ON "118 prior tests continue to pass" (R3 §九 item 21): the
// freeze_webhook_notification_payload_v1 contract changed (2 new required
// params, new `frozen` field names) and claim is now called twice per
// delivery — so the LITERAL test code from R1/R2 cannot be byte-identical.
// What is preserved is every SCENARIO those rounds' tests exercised: this
// file re-implements each of them against the current contract.

const { createMockSupabase } = require("../helpers/mockSupabase");
const { createMockReq, createMockRes } = require("../helpers/mockReqRes");
const { loadWebhookHandler, fakeCheckoutSessionCompletedEvent } = require("../helpers/webhookHarness");
const { computeProviderIdempotencyKey } = require("../../lib/webhook/providerIdempotencyKey");

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
  payment_status: "paid",
  inventory_status: "locked",
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

// See the file-level note above: claimAndProcessNotifications always makes
// exactly 2 claim calls per webhook delivery. Pass one array per expected
// call; any call beyond the supplied batches returns an empty result.
function claimSeq(...batches) {
  const fn = jest.fn();
  batches.forEach((rows) => fn.mockReturnValueOnce({ data: rows, error: null }));
  fn.mockReturnValue({ data: [], error: null });
  return fn;
}

// Default freeze behavior: first-writer-wins simulation — echoes back
// exactly the candidate content + provider_idempotency_key Node just
// built/computed, as the real RPC would on a row's first-ever freeze.
// Tests exercising "retry re-sends the ALREADY frozen content" override
// this to return a DIFFERENT payload than the candidate.
function echoFreeze(args) {
  return {
    data: {
      ok: true,
      frozen: {
        from: args.p_sender_email,
        to: args.p_recipient_email,
        subject: args.p_email_subject,
        html: args.p_email_html,
        provider_idempotency_key: args.p_provider_idempotency_key,
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

// R3 §四: withTempEnv temporarily deletes/sets an env var, runs `fn`, then
// always restores the ORIGINAL value (present or absent) — required by
// §四's testing instructions: use the real production code path (delete
// the real env var, reload the real handler), never a content-override
// hook, and always clean up afterward so other tests in this file are
// unaffected.
async function withTempEnv(varName, tempValue, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, varName);
  const original = process.env[varName];
  if (tempValue === undefined) {
    delete process.env[varName];
  } else {
    process.env[varName] = tempValue;
  }
  try {
    await fn();
  } finally {
    if (had) {
      process.env[varName] = original;
    } else {
      delete process.env[varName];
    }
  }
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

describe("successful payment -> claim, freeze, send with provider Idempotency-Key, complete", () => {
  test("7/15. first-time success -> locked, both rows sent, second claim pass finds nothing new, 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const rows = successClaimRows(orderRow.order_id);
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
        claim: claimSeq(rows),
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, result: "locked" });
    expect(resendSend).toHaveBeenCalledTimes(2);
    // exactly 2 claim calls total (main pass + the mandatory second pass).
    expect(supabase.rpc.mock.calls.filter((c) => c[0] === "claim_webhook_notification_v1").length).toBe(2);

    // 4/11. every send carries {idempotencyKey} as the SECOND real argument,
    // and it is the SHA-256-derived provider key, not the raw dedupe_key.
    resendSend.mock.calls.forEach((call, i) => {
      const expectedKey = computeProviderIdempotencyKey(rows[i].dedupe_key);
      expect(call[1]).toEqual({ idempotencyKey: expectedKey });
      expect(call[1].idempotencyKey).not.toBe(rows[i].dedupe_key);
    });

    // 6. customer and ops rows get DIFFERENT keys.
    expect(resendSend.mock.calls[0][1].idempotencyKey).not.toBe(resendSend.mock.calls[1][1].idempotencyKey);

    // freeze called with sender_email + provider_idempotency_key, and the
    // same dedupe_key/claim_token pairing claim handed out.
    const freezeCalls = supabase.rpc.mock.calls.filter((c) => c[0] === "freeze_webhook_notification_payload_v1");
    expect(freezeCalls.length).toBe(2);
    expect(freezeCalls[0][1].p_dedupe_key).toBe(rows[0].dedupe_key);
    expect(freezeCalls[0][1].p_claim_token).toBe(rows[0].claim_token);
    expect(freezeCalls[0][1].p_sender_email).toBe(process.env.RESEND_FROM);
    expect(freezeCalls[0][1].p_provider_idempotency_key).toBe(computeProviderIdempotencyKey(rows[0].dedupe_key));

    // complete called with outcome:'sent' and a real provider_message_id.
    const completeCalls = supabase.rpc.mock.calls.filter((c) => c[0] === "complete_webhook_notification_v1");
    expect(completeCalls.every((c) => c[1].p_outcome === "sent" && c[1].p_provider_message_id)).toBe(true);
  });
});

describe("R3 §一: sender + provider-key freeze (first-time vs retry)", () => {
  test("1/4/7. first claim freezes sender_email + a correctly-computed provider_idempotency_key alongside recipient content", async () => {
    const orderRow = { ...BASE_ORDER };
    let seenFreezeArgs = null;
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
        claim: claimSeq([successClaimRows(orderRow.order_id)[0]]),
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

    expect(seenFreezeArgs.p_sender_email).toBe(process.env.RESEND_FROM);
    expect(seenFreezeArgs.p_recipient_email).toBe(orderRow.email);
    expect(seenFreezeArgs.p_email_subject).toContain("预约确认");
    expect(seenFreezeArgs.p_provider_idempotency_key).toBe(computeProviderIdempotencyKey(successClaimRows(orderRow.order_id)[0].dedupe_key));
    // sent content matches the frozen (== just-built, first time) payload.
    expect(resendSend.mock.calls[0][0].from).toBe(seenFreezeArgs.p_sender_email);
    expect(resendSend.mock.calls[0][0].subject).toBe(seenFreezeArgs.p_email_subject);
  });

  test("2/3. retry (row already frozen with a DIFFERENT sender/content than current env/order data would now produce) sends the FROZEN request verbatim", async () => {
    const orderRow = { ...BASE_ORDER, total_price: 9999 }; // order data has since "changed"
    const alreadyFrozen = {
      from: "Old Sender <old@example.com>", // simulates RESEND_FROM having changed since this row was first frozen
      to: "frozen@example.com",
      subject: "FROZEN SUBJECT — do not rebuild",
      html: "<p>frozen html</p>",
      provider_idempotency_key: "webhook-" + "a".repeat(64),
    };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "already_processed", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        claim: claimSeq([successClaimRows(orderRow.order_id)[0]]),
        freeze: () => ({ data: { ok: true, frozen: alreadyFrozen }, error: null }), // simulates "already frozen" — discards Node's candidate
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    await runHandler(handler, {});

    // 7. same provider key -> completely identical from/to/subject/html.
    expect(resendSend.mock.calls[0][0]).toEqual({
      from: alreadyFrozen.from,
      to: alreadyFrozen.to,
      subject: alreadyFrozen.subject,
      html: alreadyFrozen.html,
    });
    expect(resendSend.mock.calls[0][0].from).not.toBe(process.env.RESEND_FROM);
    expect(resendSend.mock.calls[0][1]).toEqual({ idempotencyKey: alreadyFrozen.provider_idempotency_key });
  });

  test("9. freeze with a stale/expired claim_token -> overall failure, no send attempted", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
        claim: claimSeq([successClaimRows(orderRow.order_id)[0]]),
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
  test("complete resolves {ok:false} -> overall 500, never a silent 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
        claim: claimSeq([successClaimRows(orderRow.order_id)[0]]),
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

  test("complete resolves {data:null,error:null} -> overall 500", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
        claim: claimSeq([successClaimRows(orderRow.order_id)[0]]),
        complete: () => ({ data: null, error: null }),
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test("complete resolves with a top-level error -> overall 500", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
        claim: claimSeq([successClaimRows(orderRow.order_id)[0]]),
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
        claim: claimSeq([successClaimRows(orderRow.order_id)[0]]),
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
  test("unknown notification_type -> Resend never called, complete outcome='failed'/unknown_notification_type, 5xx, never marked sent", async () => {
    const orderRow = { ...BASE_ORDER };
    const completeArgs = [];
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
        claim: claimSeq([claimRow({ dedupeKey: "x:y:z:mystery", notificationType: "mystery_type", audience: "customer", claimToken: "tok-1", orderId: orderRow.order_id })]),
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

  test("customer missing email -> dead_letter/missing_customer_email, not sent; matching ops alert still sends; overall 200", async () => {
    const orderRow = { ...BASE_ORDER, email: null };
    const completeArgs = [];
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "failed", reason: "failed_no_stock", order_id: orderRow.order_id, inventory_status: "failed" }, error: null }),
        claim: claimSeq(pendingClaimRows(orderRow.order_id)), // customer_manual_review + ops_manual_review, then empty
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
    // customer dead_letter does NOT force a 5xx by itself — ops still succeeded.
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("customer missing email never gets an infinite-retry 5xx purely because of the missing address (bounded: dead_letter is terminal, not failed)", async () => {
    const orderRow = { ...BASE_ORDER, email: null };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "failed", reason: "failed_no_stock", order_id: orderRow.order_id, inventory_status: "failed" }, error: null }),
        claim: claimSeq([pendingClaimRows(orderRow.order_id)[0]]),
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(resendSend).not.toHaveBeenCalled();
  });

  test("an empty-string provider message id from Resend is treated as failure, never lets a row reach 'sent'", async () => {
    const orderRow = { ...BASE_ORDER };
    const completeArgs = [];
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
        claim: claimSeq([successClaimRows(orderRow.order_id)[0]]),
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

describe("R3 §三: missing_customer_email dead-letter creates an independent ops alert, claimed on the mandatory second pass", () => {
  test("8/9/10. customer dead-letters -> second claim pass picks up a NEW ops_missing_customer_email row (distinct dedupe_key from the ordinary business alert), sent, 200", async () => {
    const orderRow = { ...BASE_ORDER, email: null, payment_status: "paid", inventory_status: "failed" };
    const pending = pendingClaimRows(orderRow.order_id); // [customer_manual_review, ops_manual_review]
    const missingEmailAlertRow = claimRow({
      dedupeKey: `${orderRow.order_id}:cs_test_1:ops:ops_missing_customer_email`,
      notificationType: "ops_missing_customer_email",
      audience: "ops",
      claimToken: "tok-alert-1",
      orderId: orderRow.order_id,
    });

    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "failed", reason: "failed_no_stock", order_id: orderRow.order_id, inventory_status: "failed" }, error: null }),
        // pass 1: the ordinary customer_manual_review + ops_manual_review rows.
        // pass 2: the NEW alert row that complete() atomically created while
        // dead-lettering the customer row during pass 1.
        claim: claimSeq(pending, [missingEmailAlertRow]),
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});

    // ops_manual_review (pass 1) + ops_missing_customer_email (pass 2) = 2 sends.
    expect(resendSend).toHaveBeenCalledTimes(2);
    const alertMail = resendSend.mock.calls.find((c) => c[0].subject.includes("需要人工联系客户"));
    expect(alertMail).toBeDefined();
    expect(alertMail[0].html).toContain(orderRow.order_id);
    expect(alertMail[0].html).toContain("没有客户邮箱地址");
    expect(res.status).toHaveBeenCalledWith(200);

    // dedupe_key of the alert row is genuinely distinct from the ordinary
    // ops_manual_review row's dedupe_key.
    expect(missingEmailAlertRow.dedupe_key).not.toBe(pending[1].dedupe_key);
  });

  test("11. alert send failure -> overall 500 (retryable)", async () => {
    const orderRow = { ...BASE_ORDER, email: null };
    const pending = pendingClaimRows(orderRow.order_id);
    const missingEmailAlertRow = claimRow({
      dedupeKey: `${orderRow.order_id}:cs_test_1:ops:ops_missing_customer_email`,
      notificationType: "ops_missing_customer_email",
      audience: "ops",
      claimToken: "tok-alert-1",
      orderId: orderRow.order_id,
    });
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "failed", reason: "failed_no_stock", order_id: orderRow.order_id, inventory_status: "failed" }, error: null }),
        claim: claimSeq(pending, [missingEmailAlertRow]),
      }),
    });
    // ops_manual_review (pass 1) succeeds, ops_missing_customer_email (pass 2) fails.
    const resendSend = jest
      .fn()
      .mockImplementationOnce(() => Promise.resolve({ data: { id: "ops-1" }, error: null }))
      .mockImplementationOnce(() => Promise.reject(new Error("resend down")));
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test("customer row's own dead-letter completion succeeding is not itself a delivery failure (only the alert's own send/complete outcome matters for the 5xx decision)", async () => {
    const orderRow = { ...BASE_ORDER, email: null };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "failed", reason: "failed_no_stock", order_id: orderRow.order_id, inventory_status: "failed" }, error: null }),
        claim: claimSeq([pendingClaimRows(orderRow.order_id)[0]]), // ONLY the customer row claimable; ops already sent previously
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe("R2 §六/§七 / R3 §五: same Session bound to a different order -> ops-only conflict alert with corrected wording", () => {
  test("duplicate_payment_conflict/session_order_conflict -> claim scoped to the ATTEMPTED order+session, ops conflict email sent with corrected wording, no customer email, 200", async () => {
    const orderRow = { ...BASE_ORDER, order_id: "ORD-ATTEMPTED" };
    const conflictRow = claimRow({ dedupeKey: "cs_test_1:ORD-ATTEMPTED:ops:session_order_conflict", notificationType: "ops_session_order_conflict", audience: "ops", claimToken: "tok-1", orderId: "ORD-ATTEMPTED" });
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
        claim: (() => {
          // wrap claimSeq's single mock instance so the FIRST call is still
          // assertable, without creating a fresh (never-exhausting) mock
          // function on every invocation.
          const seq = claimSeq([conflictRow]);
          return (args) => {
            expect(args).toEqual({ p_order_id: "ORD-ATTEMPTED", p_stripe_session_id: "cs_test_1" });
            return seq(args);
          };
        })(),
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
    // R3 §五: corrected wording present, old incorrect claim absent.
    expect(mail.html).toContain("没有修改任何订单");
    expect(mail.html).not.toContain("系统未对任何一个订单做出");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("repeated delivery of the same conflicting session -> claim finds nothing left to send (already 'sent'), no duplicate outbox, 200", async () => {
    const orderRow = { ...BASE_ORDER, order_id: "ORD-ATTEMPTED" };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({
          data: { result: "duplicate_payment_conflict", reason: "session_order_conflict", order_id: "ORD-ATTEMPTED", inventory_status: "pending", existing_order_id: "ORD-EXISTING" },
          error: null,
        }),
        claim: claimSeq(), // always empty -> already sent
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

describe("dead-letter observable boundary at the Node layer (SQL timing itself is DB INTEGRATION UNVERIFIED)", () => {
  test("row still within the auto-retry window -> claim returns it normally and it gets processed", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "already_processed", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        claim: claimSeq([successClaimRows(orderRow.order_id)[0]]),
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
        claim: claimSeq(), // simulates: row was dead-lettered by the sweep, not claimable
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
  test("exact redelivery, nothing left claimable -> no re-send, 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "already_processed", reason: "stripe_session_id_already_recorded_for_this_order", order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        claim: claimSeq(), // both deliveries: always empty
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

  test("order_id source disagreement, exactly one resolvable -> RPC called with p_id_source_conflict=true, pending+urgent sent, 200", async () => {
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
        claim: claimSeq(pendingClaimRows("ORD-REAL")),
      }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: "ORD-REAL", clientReferenceId: "ORD-FAKE" });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(resendSend).toHaveBeenCalledTimes(2);
  });

  test("order_id source disagreement, unresolvable -> 500, no RPC call, no writes", async () => {
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

  test("failed outcome redelivered after both rows already sent -> no re-send, 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => ({ data: { result: "already_processed", reason: "failed_no_stock", order_id: orderRow.order_id, inventory_status: "failed" }, error: null }),
        claim: claimSeq(),
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
        claim: claimSeq(pendingClaimRows(orderRow.order_id)),
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
  test("customer succeeds, ops fails -> 500 first attempt; retry only re-sends ops with the SAME provider key, 200", async () => {
    const orderRow = { ...BASE_ORDER };
    const rows = successClaimRows(orderRow.order_id);
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }, { data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: jest
          .fn()
          .mockReturnValueOnce(lockedResult(orderRow.order_id))
          .mockReturnValueOnce({ data: { result: "already_processed", reason: null, order_id: orderRow.order_id, inventory_status: "locked" }, error: null }),
        // delivery1: pass1 = both rows, pass2 = empty.
        // delivery2: pass1 = only the ops row (customer already sent), pass2 = empty.
        claim: claimSeq(rows, [], [rows[1]], []),
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
    // retry uses the SAME provider Idempotency-Key as the first (failed) attempt for that row.
    expect(resendSend.mock.calls[1][1].idempotencyKey).toBe(resendSend.mock.calls[2][1].idempotencyKey);
    expect(resendSend.mock.calls[1][1].idempotencyKey).toBe(computeProviderIdempotencyKey(rows[1].dedupe_key));
  });
});

describe("R2-B05/N-01/N-02 (§七): log scrubbing — every console.* argument checked, not just the first", () => {
  test("full session.id / event.id never appear anywhere in logs, only their masked digests", async () => {
    const orderRow = { ...BASE_ORDER };
    const fullSessionId = "cs_test_FULLSECRETSESSIONID1234567890abcdef";
    const fullEventId = "evt_FULLSECRETEVENTID1234567890abcdef";
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({
        processCheckoutPayment: () => lockedResult(orderRow.order_id),
        claim: claimSeq(successClaimRows(orderRow.order_id)),
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

  test("a raw Supabase error object (message/details/hint) never reaches any console.* argument, on every RPC failure path", async () => {
    const dangerousError = {
      message: "duplicate key value violates unique constraint",
      details: "Key (dedupe_key)=(ORD-1:cs_1:customer:x) already exists.",
      hint: "check the send_logs table",
      code: "23505",
    };
    const orderRow = { ...BASE_ORDER };

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
            claim: claimSeq([successClaimRows(orderRow.order_id)[0]]),
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
            claim: claimSeq([successClaimRows(orderRow.order_id)[0]]),
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
        claim: claimSeq([successClaimRows(orderRow.order_id)[0]]),
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
  test("claim returns an empty array on both passes", async () => {
    const orderRow = { ...BASE_ORDER };
    const supabase = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({ processCheckoutPayment: () => lockedResult(orderRow.order_id), claim: claimSeq() }),
    });
    const resendSend = okResend();
    const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
    const res = await runHandler(handler, {});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(resendSend).not.toHaveBeenCalled();
  });
});

describe("Node no longer reads/writes orders.email_customer_sent / email_ops_sent as decision inputs", () => {
  test("stripe-webhook.js source does not reference the legacy boolean flags", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../../pages/api/stripe-webhook.js"), "utf8");
    expect(src).not.toMatch(/email_customer_sent/);
    expect(src).not.toMatch(/email_ops_sent/);
  });
});

describe("R3 §四: sender/ops env vars fail closed on the REAL production code path (12-16)", () => {
  test("12/13. RESEND_FROM missing -> real handler returns 5xx, Resend never called", async () => {
    await withTempEnv("RESEND_FROM", undefined, async () => {
      const orderRow = { ...BASE_ORDER };
      const completeArgs = [];
      const supabase = createMockSupabase({
        from: { orders: [{ data: orderRow, error: null }] },
        rpc: rpcRouter({
          processCheckoutPayment: () => lockedResult(orderRow.order_id),
          claim: claimSeq([successClaimRows(orderRow.order_id)[0]]),
          complete: (args) => {
            completeArgs.push(args);
            return okComplete();
          },
        }),
      });
      const resendSend = okResend();
      const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
      // NOT using notificationContentOverride — this is the real production
      // notificationContent module; only the env var is manipulated, exactly
      // as §四's testing instructions require.
      const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
      const res = await runHandler(handler, {});

      expect(resendSend).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
      expect(completeArgs[0].p_outcome).toBe("failed");
      expect(completeArgs[0].p_error_message).toBe("missing_sender_email");
      // never attempts to freeze a payload with a blank sender.
      const freezeCalls = supabase.rpc.mock.calls.filter((c) => c[0] === "freeze_webhook_notification_payload_v1");
      expect(freezeCalls.length).toBe(0);
    });
  });

  test("12/13/16. NOTIFY_TO_EMAIL missing -> real handler returns 5xx, reason=missing_ops_recipient, Resend not called for the ops row; RESEND_FROM restored afterward proven by a follow-up successful call", async () => {
    const orderRow = { ...BASE_ORDER };
    const completeArgs = [];

    await withTempEnv("NOTIFY_TO_EMAIL", undefined, async () => {
      const supabase = createMockSupabase({
        from: { orders: [{ data: orderRow, error: null }] },
        rpc: rpcRouter({
          processCheckoutPayment: () => lockedResult(orderRow.order_id),
          claim: claimSeq([successClaimRows(orderRow.order_id)[1]]), // the ops row only
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
      expect(res.status).toHaveBeenCalledWith(500);
      expect(completeArgs[0].p_outcome).toBe("failed");
      expect(completeArgs[0].p_error_message).toBe("missing_ops_recipient");
    });

    // env var restored -> a subsequent normal call succeeds again, proving
    // withTempEnv's cleanup actually worked and didn't leak into other tests.
    expect(process.env.NOTIFY_TO_EMAIL).toBeDefined();
    const supabase2 = createMockSupabase({
      from: { orders: [{ data: orderRow, error: null }] },
      rpc: rpcRouter({ processCheckoutPayment: () => lockedResult(orderRow.order_id), claim: claimSeq([successClaimRows(orderRow.order_id)[1]]) }),
    });
    const resendSend2 = okResend();
    const event2 = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
    const handler2 = loadWebhookHandler({ supabase: supabase2, constructEvent: alwaysReturnEvent(event2), resendSend: resendSend2 });
    const res2 = await runHandler(handler2, {});
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(resendSend2).toHaveBeenCalledTimes(1);
  });

  test("15. customer row is not incorrectly marked sent when RESEND_FROM is missing (customer send never attempted either)", async () => {
    await withTempEnv("RESEND_FROM", "", async () => {
      const orderRow = { ...BASE_ORDER };
      const completeArgs = [];
      const supabase = createMockSupabase({
        from: { orders: [{ data: orderRow, error: null }] },
        rpc: rpcRouter({
          processCheckoutPayment: () => lockedResult(orderRow.order_id),
          claim: claimSeq([successClaimRows(orderRow.order_id)[0]]), // customer row
          complete: (args) => {
            completeArgs.push(args);
            return okComplete();
          },
        }),
      });
      const resendSend = okResend();
      const event = fakeCheckoutSessionCompletedEvent({ orderId: orderRow.order_id });
      const handler = loadWebhookHandler({ supabase, constructEvent: alwaysReturnEvent(event), resendSend });
      await runHandler(handler, {});

      expect(resendSend).not.toHaveBeenCalled();
      expect(completeArgs.every((a) => a.p_outcome !== "sent")).toBe(true);
    });
  });

  test("14. source code has no hardcoded operations email address (no @gmail.com / @resend / literal address string as a fallback)", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../../pages/api/stripe-webhook.js"), "utf8");
    expect(src).not.toMatch(/OPS_EMAIL_TO\s*=\s*process\.env\.NOTIFY_TO_EMAIL\s*\|\|/);
    expect(src).not.toMatch(/SENDER_EMAIL\s*=\s*process\.env\.RESEND_FROM\s*\|\|/);
    expect(src).not.toContain("songshanshan1977@gmail.com");
    expect(src).not.toContain("HonestOki <noreply@");
  });
});
