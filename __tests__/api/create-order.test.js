const { createMockSupabase } = require("../helpers/mockSupabase");
const { createMockReq, createMockRes } = require("../helpers/mockReqRes");

// 三个正式车型 UUID（来自 components/BookingFlow.jsx CAR_MODEL_IDS）
const ECONOMY = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";
const ALPHARD = "82cf604f-e688-49fe-aecf-69894a01f6cb";
const HIACE = "453df662-d350-4ab9-b811-61ffcda40d4b";

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

describe("POST /api/create-order — 幂等 + 未付款draft受控更新 + 服务端价格重算", () => {
  test("新订单：服务端重新计算 total_price，不采用客户端伪造值", async () => {
    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: null, error: null }, // 查询已存在订单：不存在
          { data: { ...BASE_ORDER_INPUT, total_price: 6400, payment_status: "draft" }, error: null }, // insert 返回
        ],
      },
      rpc: () => ({ data: 1600, error: null }), // get_car_price 每日 1600
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({ body: BASE_ORDER_INPUT });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.reused).toBe(false);
    // insert 调用参数里的 total_price 必须是服务端算出的 1600*4=6400，不是客户端传的 999999
    const insertCalls = supabase.__tableCalls.orders.insert.mock.calls;
    const insertPayload = insertCalls[0][0][0];
    expect(insertPayload.total_price).toBe(6400);
    expect(insertPayload.total_price).not.toBe(999999);
  });

  test("case 13: Step4无车返回后，同一order_id修改日期重试 -> 更新同一行，价格按新日期重算", async () => {
    const existingDraft = {
      order_id: "ORD-20260802-33333",
      payment_status: "draft",
      start_date: "2026-08-02",
      end_date: "2026-08-05",
      car_model_id: ECONOMY,
      driver_lang: "ZH",
      duration: 8,
      total_price: 6400,
      deposit_amount: 500,
    };
    const updatedRow = { ...existingDraft, start_date: "2026-08-10", end_date: "2026-08-11", total_price: 3200 };

    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: existingDraft, error: null }, // 查询已存在订单
          { data: [updatedRow], error: null }, // update ...select() 返回数组（不再用 .single()）
        ],
      },
      rpc: () => ({ data: 1600, error: null }),
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: { ...BASE_ORDER_INPUT, order_id: existingDraft.order_id, start_date: "2026-08-10", end_date: "2026-08-11" },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.reused).toBe(true);
    expect(res.body.updated).toBe(true);
    expect(res.body.order.start_date).toBe("2026-08-10");
    expect(res.body.order.total_price).toBe(3200); // 1600 * 2天，用新日期重算，不是旧的6400
  });

  test("case 14: 修改未付款draft的车型/司机语言/时长 -> 服务端重新计算价格", async () => {
    const existingDraft = {
      order_id: "ORD-20260802-44444",
      payment_status: "draft",
      start_date: "2026-08-02",
      end_date: "2026-08-02",
      car_model_id: HIACE,
      driver_lang: "ZH",
      duration: 8,
      total_price: 1600,
      deposit_amount: 500,
    };
    const updatedRow = { ...existingDraft, car_model_id: ALPHARD, driver_lang: "JP", duration: 10, total_price: 2200 };

    const rpcSpy = jest.fn(() => ({ data: 2200, error: null }));
    const supabase = createMockSupabase({
      from: { orders: [{ data: existingDraft, error: null }, { data: [updatedRow], error: null }] },
      rpc: rpcSpy,
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: {
        ...BASE_ORDER_INPUT,
        order_id: existingDraft.order_id,
        car_model_id: ALPHARD,
        driver_lang: "jp",
        duration: 10,
      },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.body.order.total_price).toBe(2200);
    expect(rpcSpy).toHaveBeenCalledWith(
      "get_car_price",
      expect.objectContaining({ p_car_model_id: ALPHARD, p_driver_lang: "JP", p_duration_hours: 10 })
    );
  });

  test("case 15: 对 payment_status=paid 订单提交同order_id修改请求 -> 409 且不写库", async () => {
    const paidOrder = {
      order_id: "ORD-20260802-55555",
      payment_status: "paid",
      start_date: "2026-08-02",
      end_date: "2026-08-02",
      total_price: 1600,
    };
    const supabase = createMockSupabase({
      from: { orders: { data: paidOrder, error: null } },
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: { ...BASE_ORDER_INPUT, order_id: paidOrder.order_id, start_date: "2026-09-01" },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("paid_order_immutable");
    // 不得调用 update（数据库内容不变）
    expect(supabase.__tableCalls.orders.update).not.toHaveBeenCalled();
  });

  test("幂等: 完全相同请求重复提交，结果一致（价格不因重复提交而漂移）", async () => {
    const existingDraft = {
      order_id: "ORD-20260802-66666",
      payment_status: "draft",
      start_date: "2026-08-02",
      end_date: "2026-08-02",
      car_model_id: ECONOMY,
      driver_lang: "ZH",
      duration: 8,
      total_price: 1600,
      deposit_amount: 500,
    };
    const supabase = createMockSupabase({
      from: { orders: [{ data: existingDraft, error: null }, { data: [existingDraft], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: { ...BASE_ORDER_INPUT, order_id: existingDraft.order_id, start_date: "2026-08-02", end_date: "2026-08-02" },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.body.order.total_price).toBe(1600);
  });

  // ────────────────────────────────────────────────────────────
  // 任务一：draft 并发更新静默失败修复
  // ────────────────────────────────────────────────────────────

  test("并发1: 读到draft、条件update影响0行、复查发现已paid -> 409 paid_order_immutable，不得返回成功", async () => {
    const draftAtReadTime = {
      order_id: "ORD-20260802-77777",
      payment_status: "draft", // 读取时还是 draft
      start_date: "2026-08-02",
      end_date: "2026-08-02",
      car_model_id: ECONOMY,
      driver_lang: "ZH",
      duration: 8,
      total_price: 1600,
      deposit_amount: 500,
    };
    const nowPaid = { ...draftAtReadTime, payment_status: "paid" }; // 写入前已被 webhook 改成 paid

    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: draftAtReadTime, error: null }, // 第一次 select：读到 draft
          { data: [], error: null }, // update...eq(payment_status,'draft') 匹配 0 行
          { data: nowPaid, error: null }, // 复查：真实当前状态是 paid
        ],
      },
      rpc: () => ({ data: 1600, error: null }),
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: { ...BASE_ORDER_INPUT, order_id: draftAtReadTime.order_id, start_date: "2026-08-03" },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("paid_order_immutable");
    expect(res.body.success).toBeUndefined(); // 绝不能带 success:true
  });

  test("并发2: 读到draft、条件update影响0行、复查发现是其他非paid状态变化 -> 409 order_state_changed", async () => {
    const draftAtReadTime = {
      order_id: "ORD-20260802-88888",
      payment_status: "draft",
      start_date: "2026-08-02",
      end_date: "2026-08-02",
      car_model_id: ECONOMY,
      driver_lang: "ZH",
      duration: 8,
      total_price: 1600,
      deposit_amount: 500,
    };
    const nowPending = { ...draftAtReadTime, payment_status: "pending" }; // 被别的请求改成了 pending（仍非 draft，条件不匹配）

    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: draftAtReadTime, error: null },
          { data: [], error: null }, // update 匹配 0 行
          { data: nowPending, error: null }, // 复查：不是 paid，但状态确实变了
        ],
      },
      rpc: () => ({ data: 1600, error: null }),
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: { ...BASE_ORDER_INPUT, order_id: draftAtReadTime.order_id, start_date: "2026-08-03" },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("order_state_changed");
    expect(res.body.success).toBeUndefined();
  });

  test("正常路径: 条件update确实影响1行 -> 200 且返回更新后的行", async () => {
    const draft = {
      order_id: "ORD-20260802-99999",
      payment_status: "draft",
      start_date: "2026-08-02",
      end_date: "2026-08-02",
      car_model_id: ECONOMY,
      driver_lang: "ZH",
      duration: 8,
      total_price: 1600,
      deposit_amount: 500,
    };
    const updated = { ...draft, start_date: "2026-08-03", total_price: 1600 };

    const supabase = createMockSupabase({
      from: { orders: [{ data: draft, error: null }, { data: [updated], error: null }] },
      rpc: () => ({ data: 1600, error: null }),
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({ body: { ...BASE_ORDER_INPUT, order_id: draft.order_id, start_date: "2026-08-03" } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.updated).toBe(true);
    expect(res.body.order.start_date).toBe("2026-08-03");
  });

  test("数据库update本身报错(非0行问题) -> 500，且不泄露详情", async () => {
    const draft = {
      order_id: "ORD-20260802-10101",
      payment_status: "draft",
      start_date: "2026-08-02",
      end_date: "2026-08-02",
      car_model_id: ECONOMY,
      driver_lang: "ZH",
      duration: 8,
      total_price: 1600,
      deposit_amount: 500,
    };

    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: draft, error: null },
          { data: null, error: { message: "connection reset by peer at 10.0.0.7" } },
        ],
      },
      rpc: () => ({ data: 1600, error: null }),
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({ body: { ...BASE_ORDER_INPUT, order_id: draft.order_id, start_date: "2026-08-03" } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("order_update_failed");
    expect(JSON.stringify(res.body)).not.toMatch(/10\.0\.0\.7/);
  });

  test("任务二: duration 非法值(如9) -> 400 invalid_duration，不写库", async () => {
    const supabase = createMockSupabase({
      from: { orders: { data: null, error: null } },
      rpc: () => ({ data: 1600, error: null }),
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({ body: { ...BASE_ORDER_INPUT, duration: 9 } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("invalid_duration");
    expect(supabase.__tableCalls.orders.insert).not.toHaveBeenCalled();
  });

  test("任务二: car_model_id 不是三个正式车型之一 -> 400 invalid_car_model，不写库", async () => {
    const supabase = createMockSupabase({
      from: { orders: { data: null, error: null } },
      rpc: () => ({ data: 1600, error: null }),
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: { ...BASE_ORDER_INPUT, car_model_id: "00000000-0000-0000-0000-000000000000" },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("invalid_car_model");
  });

  test("回归: 缺少必填字段返回 400（不再要求客户端传 total_price）", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: null, error: null } } });
    const handler = loadHandler(supabase);

    const { total_price, departure_hotel, ...withoutHotel } = BASE_ORDER_INPUT;
    const req = createMockReq({ body: withoutHotel }); // 缺 departure_hotel
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/departure_hotel/);
  });

  test("回归: 缺 order_id 返回 400", async () => {
    const supabase = createMockSupabase({ from: { orders: { data: null, error: null } } });
    const handler = loadHandler(supabase);

    const req = createMockReq({ body: {} });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  test("数据库查询出错不泄露详情", async () => {
    const supabase = createMockSupabase({
      from: { orders: { data: null, error: { message: "internal secret detail" } } },
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({ body: BASE_ORDER_INPUT });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
  });
});
