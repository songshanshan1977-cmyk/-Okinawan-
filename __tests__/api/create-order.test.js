const { createMockSupabase } = require("../helpers/mockSupabase");
const { createMockReq, createMockRes } = require("../helpers/mockReqRes");

// 三个正式车型 UUID（来自 components/BookingFlow.jsx CAR_MODEL_IDS）
const ECONOMY = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";
const ALPHARD = "82cf604f-e688-49fe-aecf-69894a01f6cb";

function loadHandler(supabase) {
  let handler;
  jest.isolateModules(() => {
    jest.doMock("@supabase/supabase-js", () => ({
      createClient: jest.fn(() => supabase),
    }));
    const mod = require("../../pages/api/create-order");
    handler = mod.default || mod;
  });
  return handler;
}

// A3 revision: issuePaymentAuthorization now calls the atomic
// issue_payment_authorization_v1 RPC instead of a plain .from("orders").update()
// — every test that reaches "issue a payable result" needs an rpc() mock
// routed by name (get_car_price for pricing, issue_payment_authorization_v1
// for the authorization), never a queued "orders" update fixture.
function rpcRouter({ price = 1600 } = {}) {
  return (name, args) => {
    if (name === "get_car_price") return { data: price, error: null };
    if (name === "issue_payment_authorization_v1") {
      return { data: [{ order_id: args.p_order_id, payment_attempt_id: `attempt-for-${args.p_order_id}` }], error: null };
    }
    return { data: null, error: { message: "unknown rpc" } };
  };
}

const BASE_ORDER_INPUT = {
  order_id: "ORD-20260802-22222",
  car_model_id: ECONOMY,
  driver_lang: "zh",
  duration: 8,
  pax: 2,
  luggage: 1,
  start_date: "2026-08-02",
  end_date: "2026-08-05",
  departure_hotel: "Hotel A",
  end_hotel: "Hotel B",
  total_price: 999999, // 客户端故意伪造一个假价格，验证服务端不会采用
  name: "Test User",
  phone: "123",
  email: "a@b.com",
};

const EXISTING_DRAFT_A = {
  order_id: "ORD-20260802-AAAAA",
  payment_status: "draft",
  start_date: "2026-08-02",
  end_date: "2026-08-05",
  departure_hotel: "Hotel A",
  end_hotel: "Hotel B",
  car_model_id: ECONOMY,
  driver_lang: "ZH",
  duration: 8,
  pax: 2,
  luggage: 1,
  name: "Original Owner",
  phone: "080-0000-0000",
  email: "owner@example.com",
  wechat: null,
  itinerary: null,
  remark: null,
  source: "direct",
  total_price: 6400, // 1600 * 4天
  deposit_amount: 500,
};

const EXISTING_PENDING_A = { ...EXISTING_DRAFT_A, order_id: "ORD-20260802-PPPPP", payment_status: "pending" };

describe("POST /api/create-order — 新订单：服务端重算价格", () => {
  test("新订单：服务端重新计算 total_price，不采用客户端伪造值", async () => {
    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: null, error: null }, // 查询已存在订单：不存在
          { data: { ...BASE_ORDER_INPUT, total_price: 6400, payment_status: "draft" }, error: null }, // insert 返回
        ],
      },
      rpc: rpcRouter(),
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({ body: BASE_ORDER_INPUT });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.reused).toBe(false);
    expect(res.body.created_new_order).toBe(false);

    // A3: 顶层必须带一次性付款授权 Token，且 Token 绝不进入 order 对象内部
    expect(typeof res.body.payment_authorization_token).toBe("string");
    expect(res.body.payment_authorization_token.length).toBeGreaterThanOrEqual(32);
    expect(res.body.order.payment_authorization_token).toBeUndefined();

    // A3 revision: 授权通过原子 RPC 签发，never .from("orders").update()
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
    const issueCall = supabase.__calls.rpc.find((c) => c.name === "issue_payment_authorization_v1");
    expect(issueCall.args.p_order_id).toBe(BASE_ORDER_INPUT.order_id);

    const insertPayload = supabase.__tableCalls.orders.insert.mock.calls[0][0][0];
    expect(insertPayload.total_price).toBe(6400);
    expect(insertPayload.total_price).not.toBe(999999);
    expect(insertPayload.deposit_amount).toBe(500); // 固定常量（顺手修正9），不读取客户端值
  });

  test("回归：客户端提交 deposit_amount 也不会被采用（新订单路径）", async () => {
    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: null, error: null },
          { data: { ...BASE_ORDER_INPUT }, error: null },
        ],
      },
      rpc: rpcRouter(),
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({ body: { ...BASE_ORDER_INPUT, deposit_amount: 1 } });
    const res = createMockRes();
    await handler(req, res);

    const insertPayload = supabase.__tableCalls.orders.insert.mock.calls[0][0][0];
    expect(insertPayload.deposit_amount).toBe(500);
  });
});

describe("BLOCKING-1 修复：不再允许多字段更新他人未付款草稿", () => {
  test("7.1 陌生人篡改尝试：A 的任何字段都不变，请求被当作独立新草稿 B 处理", async () => {
    const newB = { ...EXISTING_DRAFT_A, order_id: "ORD-20260802-BBBBB", email: "attacker@evil.com", phone: "666", start_date: "2099-01-01", end_date: "2099-01-01", total_price: 1600 };

    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: EXISTING_DRAFT_A, error: null }, // 查询：命中 A
          { data: newB, error: null }, // insertNewDraftWithRetry 的 insert 返回
        ],
      },
      rpc: rpcRouter(),
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: {
        ...BASE_ORDER_INPUT,
        order_id: EXISTING_DRAFT_A.order_id, // 攻击者携带 A 的 order_id
        email: "attacker@evil.com",
        phone: "666",
        start_date: "2099-01-01",
        end_date: "2099-01-01",
      },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.created_new_order).toBe(true);
    expect(res.body.previous_order_id).toBe(EXISTING_DRAFT_A.order_id);
    expect(res.body.order.order_id).not.toBe(EXISTING_DRAFT_A.order_id); // B != A

    // 关键断言：orders 表从未被 update 过（A3 授权通过 RPC 签发，不是
    // .from("orders").update()）——A 不可能被这条请求以任何形式改动。
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
    // 授权 RPC 面向的是新草稿 B，绝不是 A。
    const issueCall = supabase.__calls.rpc.find((c) => c.name === "issue_payment_authorization_v1");
    expect(issueCall.args.p_order_id).toBe(newB.order_id);

    // insert 时使用的是攻击者提交的新内容，而不是 A 的原内容
    const insertPayload = supabase.__tableCalls.orders.insert.mock.calls[0][0][0];
    expect(insertPayload.email).toBe("attacker@evil.com");
    expect(insertPayload.order_id).not.toBe(EXISTING_DRAFT_A.order_id);
  });

  test("7.2 相同规范化内容重复提交：返回原 A，insert 0 次，update 0 次（授权走 RPC）", async () => {
    const supabase = createMockSupabase({
      from: { orders: { data: EXISTING_DRAFT_A, error: null } },
      rpc: rpcRouter(), // 1600*4=6400，与 A 的 total_price 一致
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: {
        ...BASE_ORDER_INPUT,
        order_id: EXISTING_DRAFT_A.order_id,
        start_date: EXISTING_DRAFT_A.start_date,
        end_date: EXISTING_DRAFT_A.end_date,
        departure_hotel: EXISTING_DRAFT_A.departure_hotel,
        end_hotel: EXISTING_DRAFT_A.end_hotel,
        car_model_id: EXISTING_DRAFT_A.car_model_id,
        driver_lang: "zh",
        duration: EXISTING_DRAFT_A.duration,
        pax: EXISTING_DRAFT_A.pax,
        luggage: EXISTING_DRAFT_A.luggage,
        name: EXISTING_DRAFT_A.name,
        phone: EXISTING_DRAFT_A.phone,
        email: EXISTING_DRAFT_A.email,
      },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.reused).toBe(true);
    expect(res.body.created_new_order).toBe(false);
    expect(res.body.order.order_id).toBe(EXISTING_DRAFT_A.order_id);

    expect(supabase.__tableCalls.orders.insert).not.toHaveBeenCalled();
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
    const issueCall = supabase.__calls.rpc.find((c) => c.name === "issue_payment_authorization_v1");
    expect(issueCall.args.p_order_id).toBe(EXISTING_DRAFT_A.order_id);
  });

  test("7.3 仅客户端 total_price 变化（其余业务字段相同）：视为相同内容，不新建订单", async () => {
    const supabase = createMockSupabase({
      from: { orders: { data: EXISTING_DRAFT_A, error: null } },
      rpc: rpcRouter(),
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: {
        ...BASE_ORDER_INPUT,
        order_id: EXISTING_DRAFT_A.order_id,
        start_date: EXISTING_DRAFT_A.start_date,
        end_date: EXISTING_DRAFT_A.end_date,
        departure_hotel: EXISTING_DRAFT_A.departure_hotel,
        end_hotel: EXISTING_DRAFT_A.end_hotel,
        car_model_id: EXISTING_DRAFT_A.car_model_id,
        driver_lang: "zh",
        duration: EXISTING_DRAFT_A.duration,
        pax: EXISTING_DRAFT_A.pax,
        luggage: EXISTING_DRAFT_A.luggage,
        name: EXISTING_DRAFT_A.name,
        phone: EXISTING_DRAFT_A.phone,
        email: EXISTING_DRAFT_A.email,
        total_price: 1, // 唯一变化：客户端伪造成 1 元
      },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.body.reused).toBe(true);
    expect(res.body.created_new_order).toBe(false);
    expect(res.body.order.total_price).toBe(6400); // 仍是 A 的服务端原值，不是 1
    expect(supabase.__tableCalls.orders.insert).not.toHaveBeenCalled();
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
  });

  test("7.4a 已付款订单收到相同内容 -> 409，不 insert 不 update，不签发授权", async () => {
    const paidOrder = { ...EXISTING_DRAFT_A, payment_status: "paid" };
    const supabase = createMockSupabase({ from: { orders: { data: paidOrder, error: null } } });
    const handler = loadHandler(supabase);

    const req = createMockReq({ body: { ...BASE_ORDER_INPUT, order_id: paidOrder.order_id } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("paid_order_immutable");
    expect(supabase.__tableCalls.orders.insert).not.toHaveBeenCalled();
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
    expect(supabase.__calls.rpc.length).toBe(0);
  });

  test("7.4b 已付款订单收到不同内容 -> 同样 409，不会静默创建新单替代", async () => {
    const paidOrder = { ...EXISTING_DRAFT_A, payment_status: "paid" };
    const supabase = createMockSupabase({ from: { orders: { data: paidOrder, error: null } } });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: { ...BASE_ORDER_INPUT, order_id: paidOrder.order_id, start_date: "2099-01-01", end_date: "2099-01-01" },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("paid_order_immutable");
    expect(res.body.created_new_order).toBeUndefined();
    expect(supabase.__tableCalls.orders.insert).not.toHaveBeenCalled();
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
  });

  test("7.5 新ID冲突重试：第一次新ID唯一冲突，第二次成功，A 不受影响", async () => {
    const conflict = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
    const newC = { ...EXISTING_DRAFT_A, order_id: "ORD-20260802-CCCCC", start_date: "2026-09-01", end_date: "2026-09-01", total_price: 1600 };

    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: EXISTING_DRAFT_A, error: null }, // 查询命中 A
          conflict, // 第一次新 draft insert：唯一冲突
          { data: newC, error: null }, // 第二次新 draft insert：成功
        ],
      },
      rpc: rpcRouter(),
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: { ...BASE_ORDER_INPUT, order_id: EXISTING_DRAFT_A.order_id, start_date: "2026-09-01", end_date: "2026-09-01" },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.created_new_order).toBe(true);
    expect(res.body.order.order_id).toBe("ORD-20260802-CCCCC");
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
    const issueCall = supabase.__calls.rpc.find((c) => c.name === "issue_payment_authorization_v1");
    expect(issueCall.args.p_order_id).toBe("ORD-20260802-CCCCC");
    // insert 恰好被调用 2 次（第一次冲突 + 第二次成功），重试次数受限
    expect(supabase.__tableCalls.orders.insert.mock.calls.length).toBe(2);
  });
});

describe("A3 payment-attempt idempotency: pending 状态分支", () => {
  test("pending + 内容相同 -> 200，允许重新签发 Token（保留同一 payment_attempt_id，由 issue_payment_authorization_v1 决定），不 insert", async () => {
    const supabase = createMockSupabase({
      from: { orders: { data: EXISTING_PENDING_A, error: null } },
      rpc: rpcRouter(),
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: {
        ...BASE_ORDER_INPUT,
        order_id: EXISTING_PENDING_A.order_id,
        start_date: EXISTING_PENDING_A.start_date,
        end_date: EXISTING_PENDING_A.end_date,
        departure_hotel: EXISTING_PENDING_A.departure_hotel,
        end_hotel: EXISTING_PENDING_A.end_hotel,
        car_model_id: EXISTING_PENDING_A.car_model_id,
        driver_lang: "zh",
        duration: EXISTING_PENDING_A.duration,
        pax: EXISTING_PENDING_A.pax,
        luggage: EXISTING_PENDING_A.luggage,
        name: EXISTING_PENDING_A.name,
        phone: EXISTING_PENDING_A.phone,
        email: EXISTING_PENDING_A.email,
      },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.reused).toBe(true);
    expect(res.body.created_new_order).toBe(false);
    expect(typeof res.body.payment_authorization_token).toBe("string");
    expect(supabase.__tableCalls.orders.insert).not.toHaveBeenCalled();
    const issueCall = supabase.__calls.rpc.find((c) => c.name === "issue_payment_authorization_v1");
    expect(issueCall.args.p_order_id).toBe(EXISTING_PENDING_A.order_id);
  });

  test("pending + 内容不同 -> 409 payment_pending_immutable，不 insert 新草稿（不得绕过已有付款尝试），不签发授权", async () => {
    const supabase = createMockSupabase({
      from: { orders: { data: EXISTING_PENDING_A, error: null } },
      rpc: rpcRouter(),
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: { ...BASE_ORDER_INPUT, order_id: EXISTING_PENDING_A.order_id, start_date: "2099-01-01", end_date: "2099-01-01" },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("payment_pending_immutable");
    expect(supabase.__tableCalls.orders.insert).not.toHaveBeenCalled();
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
    expect(supabase.__calls.rpc.filter((c) => c.name === "issue_payment_authorization_v1").length).toBe(0);
  });
});

describe("回归：既有行为保持", () => {
  test("缺少必填字段返回 400（新订单路径）", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: null, error: null } } });
    const handler = loadHandler(supabase);

    const { departure_hotel, ...withoutHotel } = BASE_ORDER_INPUT;
    const req = createMockReq({ body: withoutHotel });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/departure_hotel/);
  });

  test("缺少必填字段返回 400（既有草稿分支）", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: EXISTING_DRAFT_A, error: null } } });
    const handler = loadHandler(supabase);

    const { departure_hotel, ...withoutHotel } = BASE_ORDER_INPUT;
    const req = createMockReq({ body: { ...withoutHotel, order_id: EXISTING_DRAFT_A.order_id } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  test("缺 order_id 返回 400", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: null, error: null } } });
    const handler = loadHandler(supabase);

    const req = createMockReq({ body: {} });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  test("查询数据库出错不泄露详情", async () => {
    const supabase = createMockSupabase({
      from: { orders: { data: null, error: { message: "internal secret detail" } } },
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({ body: BASE_ORDER_INPUT });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/internal secret detail/);
  });

  test("车型/时长非法值仍被拒绝（新订单路径）", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: null, error: null } }, rpc: rpcRouter() });
    const handler = loadHandler(supabase);

    const req = createMockReq({ body: { ...BASE_ORDER_INPUT, duration: 9 } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("invalid_duration");
  });

  test("代码级确认：整个文件从未对 orders 表调用过 .update()（旧的多字段草稿更新能力已彻底移除；A3 授权也不走 .update()，走原子 RPC）", async () => {
    const fs = require("fs");
    const source = fs.readFileSync(require.resolve("../../pages/api/create-order.js"), "utf8");
    expect(source).not.toMatch(/DRAFT_UPDATE_WHITELIST/);
    expect(source).not.toMatch(/\.update\(/);
  });
});
