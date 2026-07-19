const { createMockSupabase } = require("../helpers/mockSupabase");
const { createMockReq, createMockRes } = require("../helpers/mockReqRes");

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
  car_model_id: "car-1",
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
      car_model_id: "car-1",
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
          { data: updatedRow, error: null }, // update 返回
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
      car_model_id: "car-old",
      driver_lang: "ZH",
      duration: 8,
      total_price: 1600,
      deposit_amount: 500,
    };
    const updatedRow = { ...existingDraft, car_model_id: "car-new", driver_lang: "JP", duration: 10, total_price: 2200 };

    const rpcSpy = jest.fn(() => ({ data: 2200, error: null }));
    const supabase = createMockSupabase({
      from: { orders: [{ data: existingDraft, error: null }, { data: updatedRow, error: null }] },
      rpc: rpcSpy,
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: {
        ...BASE_ORDER_INPUT,
        order_id: existingDraft.order_id,
        car_model_id: "car-new",
        driver_lang: "jp",
        duration: 10,
      },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.body.order.total_price).toBe(2200);
    expect(rpcSpy).toHaveBeenCalledWith(
      "get_car_price",
      expect.objectContaining({ p_car_model_id: "car-new", p_driver_lang: "JP", p_duration_hours: 10 })
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
      car_model_id: "car-1",
      driver_lang: "ZH",
      duration: 8,
      total_price: 1600,
      deposit_amount: 500,
    };
    const supabase = createMockSupabase({
      from: { orders: [{ data: existingDraft, error: null }, { data: existingDraft, error: null }] },
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
