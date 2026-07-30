// __tests__/agent/lib/a3ClosedLoop.test.js
//
// A3 end-to-end closed-loop test: draft creation -> summary -> (attempt
// payment link before confirmation, must fail) -> confirm H1 -> update
// (content changes to H2, confirmation cleared) -> (attempt payment link
// with the now-cleared confirmation, must fail) -> confirm H2 -> payment
// link succeeds (pending) -> a same-attempt retry recovers the same Stripe
// session -> update/confirm now reject the pending order -> simulated
// webhook payment -> get_payment_status reports paid.
//
// Same stateful in-memory fake `orders`/`inventory_rules_v2` "database"
// approach as __tests__/agent/lib/a2ClosedLoop.test.js (the queue-based
// createMockSupabase helper cannot represent state persisting/evolving
// across a multi-tool-call flow). Zero real network I/O.
//
// IMPORTANT SCOPE NOTE (per this round's instructions: "Mock不得冒充真实
// Postgres并发验证"): the fake `rpc("issue_payment_authorization_v1", ...)`
// and `rpc("consume_payment_authorization_v1", ...)` below re-implement the
// SAME decision/WHERE-clause logic as
// supabase/migrations/20260729120000_payment_authorization_v1.sql's real SQL
// functions, in plain synchronous JS, purely to exercise this file's
// single-threaded, sequential closed-loop scenario end to end (including a
// same-order-same-summary retry converging on the same payment_attempt_id).
// This does NOT demonstrate — and must never be read as demonstrating —
// that two GENUINELY concurrent database transactions racing on the same
// row can only have one decide the attempt id; that atomicity guarantee
// comes from Postgres's own MVCC/row-locking on a single UPDATE statement
// and is verified only by the static SQL text assertions in
// __tests__/agent/sql/migrationPaymentAuthorizationStatic.test.js. Real
// concurrent-access behavior remains DB INTEGRATION UNVERIFIED (see this
// round's completion report) — this file, like every other test in this
// project, never runs against a real Postgres.
//
// pages/api/stripe-webhook.js itself is never invoked here (out of scope
// for this round — "原则上不修改", and it has its own Resend/Stripe
// dependencies this file has no reason to mock). "Webhook 模拟 paid" below
// means directly performing the ONE authoritative write that file's
// checkout.session.completed handler makes — `payment_status: "paid"` — on
// this fake's own store, exactly mirroring that single line of real
// behavior without pulling in the rest of that handler.

const { createBookingDraftTool } = require("../../../lib/agent/tools/createBookingDraft");
const { getBookingSummaryTool } = require("../../../lib/agent/tools/getBookingSummary");
const { updateBookingDraftTool } = require("../../../lib/agent/tools/updateBookingDraft");
const { confirmBookingSummaryTool } = require("../../../lib/agent/tools/confirmBookingSummary");
const { createPaymentLinkTool } = require("../../../lib/agent/tools/createPaymentLink");
const { getPaymentStatusTool } = require("../../../lib/agent/tools/getPaymentStatus");
const { issuePaymentAuthorization } = require("../../../lib/payment/paymentAuthorization");
const { AGENT_ERROR_CODES } = require("../../../lib/agent/errorCodes");
const { TEST_AGENT_BOOKING_TOKEN_SECRET } = require("../helpers/testSecrets");

const CAR = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";

function createFakeSupabase({ failNthOrdersUpdate } = {}) {
  const orders = new Map();
  const inventory = [];
  let ordersUpdateCallCount = 0;

  function matchOrders(filters) {
    return [...orders.values()].filter((r) => filters.every((f) => r[f.col] === f.val));
  }

  function ordersTable() {
    let filters = [];
    let mode = null;
    let payload = null;
    let upsertOpts = null;

    const api = {
      select() {
        if (!mode) mode = "select";
        return api;
      },
      eq(col, val) {
        filters.push({ col, val });
        return api;
      },
      update(row) {
        mode = "update";
        payload = row;
        return api;
      },
      upsert(row, opts) {
        mode = "upsert";
        payload = row;
        upsertOpts = opts;
        return api;
      },
      async maybeSingle() {
        const res = await run();
        const arr = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
        return { data: arr[0] || null, error: res.error };
      },
      then(resolve, reject) {
        return run().then(resolve, reject);
      },
    };

    async function run() {
      if (mode === "select" || mode === null) {
        return { data: matchOrders(filters).map((r) => ({ ...r })), error: null };
      }
      if (mode === "update") {
        ordersUpdateCallCount += 1;
        if (failNthOrdersUpdate && ordersUpdateCallCount === failNthOrdersUpdate) {
          return { data: null, error: { message: "simulated db down" } };
        }
        const matches = matchOrders(filters);
        matches.forEach((r) => Object.assign(r, payload));
        return { data: matches.map((r) => ({ ...r })), error: null };
      }
      if (mode === "upsert") {
        const conflictCol = upsertOpts && upsertOpts.onConflict;
        if (conflictCol && payload[conflictCol] != null) {
          const conflictRow = [...orders.values()].find((r) => r[conflictCol] === payload[conflictCol]);
          if (conflictRow) return { data: [], error: null };
        }
        if (orders.has(payload.order_id)) {
          return { data: null, error: { code: "23505" } };
        }
        orders.set(payload.order_id, { ...payload });
        return { data: [{ ...orders.get(payload.order_id) }], error: null };
      }
      return { data: null, error: null };
    }

    return api;
  }

  function inventoryTable() {
    let filters = [];
    const api = {
      select() {
        return api;
      },
      eq(col, val) {
        filters.push({ col, val, type: "eq" });
        return api;
      },
      in(col, vals) {
        filters.push({ col, vals, type: "in" });
        return api;
      },
      then(resolve, reject) {
        const data = inventory.filter((row) => filters.every((f) => (f.type === "eq" ? row[f.col] === f.val : f.vals.includes(row[f.col]))));
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return api;
  }

  // See file header: re-implements issue_payment_authorization_v1's decision
  // rule in plain JS for THIS file's single-threaded scenario only — never a
  // stand-in for real Postgres atomicity/concurrency guarantees.
  function issuePaymentAuthorizationRpc({ p_order_id, p_token_hash, p_candidate_attempt_id, p_summary_hash, p_deposit_amount, p_expires_at }) {
    const order = orders.get(p_order_id);
    if (!order) return Promise.resolve({ data: [], error: null });

    const keepExisting =
      Boolean(order.payment_attempt_id) &&
      order.payment_authorization_summary_hash === p_summary_hash &&
      (order.payment_status === "draft" || order.payment_status === "pending");

    const attemptId = keepExisting ? order.payment_attempt_id : p_candidate_attempt_id;

    Object.assign(order, {
      payment_authorization_token_hash: p_token_hash,
      payment_authorization_summary_hash: p_summary_hash,
      payment_authorization_deposit_amount: p_deposit_amount,
      payment_authorization_expires_at: p_expires_at,
      payment_authorization_consumed_at: null,
      payment_attempt_id: attemptId,
    });

    return Promise.resolve({ data: [{ order_id: order.order_id, payment_attempt_id: attemptId }], error: null });
  }

  // See file header: re-implements consume_payment_authorization_v1's
  // WHERE-clause matching logic in plain JS.
  function consumePaymentAuthorizationRpc({ p_order_id, p_token_hash }) {
    const order = orders.get(p_order_id);
    const isMatch =
      order &&
      order.payment_authorization_token_hash === p_token_hash &&
      !order.payment_authorization_consumed_at &&
      order.payment_authorization_expires_at &&
      new Date(order.payment_authorization_expires_at).getTime() > Date.now() &&
      (order.payment_status === "draft" || order.payment_status === "pending");

    if (!isMatch) {
      return Promise.resolve({ data: [], error: null });
    }

    order.payment_authorization_consumed_at = new Date().toISOString();

    return Promise.resolve({
      data: [
        {
          order_id: order.order_id,
          start_date: order.start_date,
          end_date: order.end_date,
          car_model_id: order.car_model_id,
          driver_lang: order.driver_lang,
          duration: order.duration,
          pax: order.pax,
          luggage: order.luggage,
          departure_hotel: order.departure_hotel,
          end_hotel: order.end_hotel,
          total_price: order.total_price,
          deposit_amount: order.deposit_amount,
          payment_status: order.payment_status,
          inventory_status: order.inventory_status,
          payment_authorization_summary_hash: order.payment_authorization_summary_hash,
          payment_authorization_deposit_amount: order.payment_authorization_deposit_amount,
          payment_attempt_id: order.payment_attempt_id,
          stripe_session_id: order.stripe_session_id,
        },
      ],
      error: null,
    });
  }

  const supabase = {
    from: jest.fn((table) => {
      if (table === "orders") return ordersTable();
      if (table === "inventory_rules_v2") return inventoryTable();
      throw new Error("createFakeSupabase: no fixture for table " + table);
    }),
    rpc: jest.fn((name, args) => {
      if (name === "get_car_price") return Promise.resolve({ data: 1600, error: null });
      if (name === "issue_payment_authorization_v1") return issuePaymentAuthorizationRpc(args);
      if (name === "consume_payment_authorization_v1") return consumePaymentAuthorizationRpc(args);
      return Promise.resolve({ data: null, error: { message: "unknown rpc" } });
    }),
  };

  return { supabase, orders, inventory };
}

// Fake Stripe that always returns the SAME id/url regardless of call count —
// this simulates what real Stripe guarantees for two calls sharing the same
// idempotencyKey+params (the customer's card is never charged twice, the
// SAME Checkout Session object is returned both times).
function fakeStripe() {
  return { checkout: { sessions: { create: jest.fn(() => Promise.resolve({ id: "cs_a3_loop_1", url: "https://stripe.invalid/pay/cs_a3_loop_1" })) } } };
}

async function seedConfirmedDraft(supabase, inventory, idempotencyKey) {
  inventory.push({ car_model_id: CAR, driver_lang: "ZH", date: "2099-09-01", remaining_qty_calc: 5 });
  const draftInput = {
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
  const draftResult = await createBookingDraftTool({ supabase, data: draftInput, idempotencyKey });
  const order_id = draftResult.order_id;
  const summary = await getBookingSummaryTool({ supabase, order_id });
  await confirmBookingSummaryTool({ supabase, order_id, summary_hash: summary.summary_hash });
  return order_id;
}

describe("A3 closed loop: unconfirmed -> fail, confirm H1 -> content changes to H2 -> fail, confirm H2 -> payment link (pending), retry idempotency, pending rejects update/confirm, webhook paid -> get_payment_status", () => {
  beforeEach(() => {
    process.env.AGENT_BOOKING_TOKEN_SECRET = TEST_AGENT_BOOKING_TOKEN_SECRET;
    process.env.NEXT_PUBLIC_SITE_URL = "https://sandbox.invalid";
  });
  afterEach(() => {
    delete process.env.AGENT_BOOKING_TOKEN_SECRET;
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  test("full loop", async () => {
    const { supabase, inventory, orders } = createFakeSupabase();
    ["2099-09-01", "2099-09-02", "2099-09-03", "2099-09-04", "2099-09-05"].forEach((date) => {
      inventory.push({ car_model_id: CAR, driver_lang: "ZH", date, remaining_qty_calc: 5 });
    });

    // 1. Create draft.
    const draftInput = {
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
    const draftResult = await createBookingDraftTool({ supabase, data: draftInput, idempotencyKey: "a3-e2e-key-1" });
    expect(draftResult.ok).toBe(true);
    const order_id = draftResult.order_id;

    // 2. 未确认 -> create_payment_link 必须失败.
    const linkBeforeConfirm = await createPaymentLinkTool({ supabase, stripe: fakeStripe(), order_id });
    expect(linkBeforeConfirm.ok).toBe(false);
    expect(linkBeforeConfirm.code).toBe(AGENT_ERROR_CODES.SUMMARY_NOT_CONFIRMED);

    // 3. 获取摘要 H1，确认 H1.
    const summary1 = await getBookingSummaryTool({ supabase, order_id });
    expect(summary1.ok).toBe(true);
    const H1 = summary1.summary_hash;

    const confirmH1 = await confirmBookingSummaryTool({ supabase, order_id, summary_hash: H1 });
    expect(confirmH1.ok).toBe(true);

    // 4. 订单内容变化（end_hotel 变了）-> 确认被清空，摘要变为 H2.
    const updateResult = await updateBookingDraftTool({
      supabase,
      order_id,
      expected_summary_hash: H1,
      changes: { end_hotel: "Hotel Z" },
    });
    expect(updateResult.ok).toBe(true);
    const H2 = updateResult.summary_hash;
    expect(H2).not.toBe(H1);
    expect(orders.get(order_id).agent_summary_confirmed_hash).toBeNull();

    // 5. 确认H1后订单变H2 -> create_payment_link 必须失败（此刻确认已被清空）.
    const linkAfterStaleConfirm = await createPaymentLinkTool({ supabase, stripe: fakeStripe(), order_id });
    expect(linkAfterStaleConfirm.ok).toBe(false);
    expect(linkAfterStaleConfirm.code).toBe(AGENT_ERROR_CODES.SUMMARY_NOT_CONFIRMED);

    // 6. 确认当前 H2.
    const confirmH2 = await confirmBookingSummaryTool({ supabase, order_id, summary_hash: H2 });
    expect(confirmH2.ok).toBe(true);
    expect(confirmH2.summary_hash).toBe(H2);

    // 7. 确认当前 H2 后 -> create_payment_link 创建链接成功并 pending.
    const stripe = fakeStripe();
    const linkResult = await createPaymentLinkTool({ supabase, stripe, order_id });
    expect(linkResult.ok).toBe(true);
    expect(linkResult.payment_status).toBe("pending");
    expect(linkResult.url).toBe("https://stripe.invalid/pay/cs_a3_loop_1");
    expect(orders.get(order_id).payment_status).toBe("pending");
    expect(orders.get(order_id).payment_authorization_consumed_at).not.toBeNull();

    // 7b. update_booking_draft / confirm_booking_summary 遇到 pending 拒绝
    // （A3 修订：不再像 draft 一样"仍可编辑"——已有真实付款尝试的订单内容必须
    // 冻结）。
    const updateOnPending = await updateBookingDraftTool({ supabase, order_id, expected_summary_hash: H2, changes: { remark: "should not land" } });
    expect(updateOnPending.ok).toBe(false);
    expect(updateOnPending.code).toBe(AGENT_ERROR_CODES.PAID_ORDER_IMMUTABLE);

    const confirmOnPending = await confirmBookingSummaryTool({ supabase, order_id, summary_hash: H2 });
    expect(confirmOnPending.ok).toBe(false);
    expect(confirmOnPending.code).toBe(AGENT_ERROR_CODES.PAID_ORDER_IMMUTABLE);

    // get_payment_status 在 webhook 之前必须是 paid:false.
    const statusBeforeWebhook = await getPaymentStatusTool({ supabase, order_id });
    expect(statusBeforeWebhook.ok).toBe(true);
    expect(statusBeforeWebhook.payment_status).toBe("pending");
    expect(statusBeforeWebhook.paid).toBe(false);

    // 8. Webhook 模拟 paid（见文件头：只复刻 stripe-webhook.js 那一行权威写入,
    // 不调用该文件本身）.
    orders.get(order_id).payment_status = "paid";

    // 9. get_payment_status paid=true.
    const statusAfterWebhook = await getPaymentStatusTool({ supabase, order_id });
    expect(statusAfterWebhook.ok).toBe(true);
    expect(statusAfterWebhook.payment_status).toBe("paid");
    expect(statusAfterWebhook.paid).toBe(true);
  });

  test("两次新 Token、同一订单和摘要 -> 权威 payment_attempt_id 相同，Stripe idempotencyKey 相同，Session id/url 相同（Agent 超时重试不创建第二个 Session）", async () => {
    const { supabase, inventory, orders } = createFakeSupabase();
    const order_id = await seedConfirmedDraft(supabase, inventory, "a3-e2e-retry-key");

    const stripe = fakeStripe();
    const first = await createPaymentLinkTool({ supabase, stripe, order_id });
    const attemptIdAfterFirst = orders.get(order_id).payment_attempt_id;

    // 模拟 Agent 超时后重试：同一订单、同一（此刻仍然当前的）摘要，再次调用。
    const second = await createPaymentLinkTool({ supabase, stripe, order_id });
    const attemptIdAfterSecond = orders.get(order_id).payment_attempt_id;

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(attemptIdAfterFirst).toBeTruthy();
    expect(attemptIdAfterFirst).toBe(attemptIdAfterSecond); // 权威 attempt id 相同

    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
    const key1 = stripe.checkout.sessions.create.mock.calls[0][1].idempotencyKey;
    const key2 = stripe.checkout.sessions.create.mock.calls[1][1].idempotencyKey;
    expect(key1).toBe(key2); // Stripe idempotencyKey 相同
    expect(key1).toBe(`checkout:${attemptIdAfterFirst}`);

    expect(first.url).toBe(second.url); // Session id/url 相同（fake Stripe 模拟真实 Stripe 的幂等返回）
  });

  test("并发签发（Promise.all 两个 issuePaymentAuthorization 调用，同一订单同一摘要）由 RPC 返回同一权威 payment_attempt_id", async () => {
    const { supabase, inventory, orders } = createFakeSupabase();
    const order_id = await seedConfirmedDraft(supabase, inventory, "a3-e2e-concurrent-key");
    const currentOrder = orders.get(order_id);

    // 注意（见文件头）：Promise.all 在单线程 JS 事件循环里不构成真正的数据库级
    // 并发——这里验证的是"两次几乎同时发起的签发调用，只要摘要相同，就必须
    // 收敛到同一个权威 attempt id"这条应用层契约本身，而不是 Postgres 行锁的
    // 真实并发保证（那部分只能由静态 SQL 断言验证）。
    const [r1, r2] = await Promise.all([issuePaymentAuthorization({ supabase, order: currentOrder }), issuePaymentAuthorization({ supabase, order: currentOrder })]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.payment_attempt_id).toBe(r2.payment_attempt_id);
    expect(r1.token).not.toBe(r2.token); // Token 每次都不同，attempt id 相同
  });

    // failNthOrdersUpdate 计数覆盖整个场景里所有 .from("orders").update() 调用
    // （createBookingDraftTool 用的是 .upsert()，不计入）：
    //   第 1 次 update() = seedConfirmedDraft 里 confirm_booking_summary 写入确认字段（必须成功，否则后面直接卡在 summary_not_confirmed）
    //   第 2 次 update() = 第一次 createPaymentLinkTool 调用里 createCheckoutSession 的写回（本测试要让它失败）
    //   第 3 次 update() = 第二次 createPaymentLinkTool 调用（重试）的写回（应当成功）
  test("Stripe 成功但数据库写回失败后重试：同一 idempotencyKey 恢复同一 Session，第二次写回成功", async () => {
    const { supabase, inventory, orders } = createFakeSupabase({ failNthOrdersUpdate: 2 });
    const order_id = await seedConfirmedDraft(supabase, inventory, "a3-e2e-writeback-key");

    const stripe = fakeStripe();
    const first = await createPaymentLinkTool({ supabase, stripe, order_id });
    expect(first.ok).toBe(false);
    expect(first.code).toBe(AGENT_ERROR_CODES.PAYMENT_SESSION_WRITE_FAILED);
    // 写回失败不恢复 Token，但 attempt id 已经落库（由签发阶段决定），订单本身仍是可继续使用的状态
    const attemptIdAfterFirst = orders.get(order_id).payment_attempt_id;
    expect(attemptIdAfterFirst).toBeTruthy();

    const second = await createPaymentLinkTool({ supabase, stripe, order_id });
    expect(second.ok).toBe(true);
    expect(orders.get(order_id).payment_attempt_id).toBe(attemptIdAfterFirst); // 同一 attempt，未产生第二个
    expect(orders.get(order_id).payment_status).toBe("pending");

    const key1 = stripe.checkout.sessions.create.mock.calls[0][1].idempotencyKey;
    const key2 = stripe.checkout.sessions.create.mock.calls[1][1].idempotencyKey;
    expect(key1).toBe(key2);
  });

  test("zero real network requests occur anywhere in the loop (fetch is guarded globally by jest.setup.js)", async () => {
    const { supabase, inventory } = createFakeSupabase();
    const order_id = await seedConfirmedDraft(supabase, inventory, "a3-e2e-key-3");
    await createPaymentLinkTool({ supabase, stripe: fakeStripe(), order_id });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
