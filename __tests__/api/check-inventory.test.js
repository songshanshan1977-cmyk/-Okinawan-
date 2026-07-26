const { createMockSupabase } = require("../helpers/mockSupabase");
const { createMockReq, createMockRes } = require("../helpers/mockReqRes");

function loadHandler(mockSupabase) {
  let handler;
  jest.isolateModules(() => {
    jest.doMock("@supabase/supabase-js", () => ({
      createClient: jest.fn(() => mockSupabase),
    }));
    const mod = require("../../pages/api/check-inventory");
    handler = mod.default || mod;
  });
  return handler;
}

function row(date, remaining) {
  return { date, remaining_qty_calc: remaining };
}

describe("POST /api/check-inventory", () => {
  test("case 01: 单日有车", async () => {
    const supabase = createMockSupabase({
      from: { inventory_rules_v2: { data: [row("2026-08-02", 2)], error: null } },
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({ body: { date: "2026-08-02", car_model_id: "car-1", driver_lang: "zh" } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.body.available).toBe(true);
    expect(res.body.unavailable_dates).toEqual([]);
  });

  test("case 02: 单日无车", async () => {
    const supabase = createMockSupabase({
      from: { inventory_rules_v2: { data: [row("2026-08-02", 0)], error: null } },
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({ body: { date: "2026-08-02", car_model_id: "car-1", driver_lang: "zh" } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.body.available).toBe(false);
    expect(res.body.unavailable_dates).toEqual([{ date: "2026-08-02", reason: "sold_out" }]);
  });

  test("case 03: 2~5日全部有车 -> available:true", async () => {
    const supabase = createMockSupabase({
      from: {
        inventory_rules_v2: {
          data: [row("2026-08-02", 3), row("2026-08-03", 2), row("2026-08-04", 1), row("2026-08-05", 5)],
          error: null,
        },
      },
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: { start_date: "2026-08-02", end_date: "2026-08-05", car_model_id: "car-1", driver_lang: "zh" },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.unavailable_dates).toEqual([]);
    expect(res.body.ok).toBe(true); // 旧字段兼容
  });

  test("case 04+05 混合: 部分售罄+部分缺行 -> unavailable_dates 含两种 reason", async () => {
    const supabase = createMockSupabase({
      from: {
        inventory_rules_v2: {
          data: [row("2026-08-02", 3), row("2026-08-04", 0)], // 缺 03、05；04 售罄
          error: null,
        },
      },
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: { start_date: "2026-08-02", end_date: "2026-08-05", car_model_id: "car-1", driver_lang: "ZH" },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.body.available).toBe(false);
    expect(res.body.unavailable_dates).toEqual([
      { date: "2026-08-03", reason: "inventory_missing" },
      { date: "2026-08-04", reason: "sold_out" },
      { date: "2026-08-05", reason: "inventory_missing" },
    ]);
  });

  test("回归: 原单日 {date} 请求仍可用", async () => {
    const supabase = createMockSupabase({
      from: { inventory_rules_v2: { data: [row("2026-08-02", 1)], error: null } },
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({ body: { date: "2026-08-02", car_model_id: "car-1", driver_lang: "zh" } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.checked).toEqual({ start_date: "2026-08-02", end_date: "2026-08-02", days_count: 1 });
  });

  test("回归: 只传 start_date、既无 end_date 也无 date -> 400（不猜测对方想查单日还是区间）", async () => {
    const supabase = createMockSupabase({
      from: { inventory_rules_v2: { data: [row("2026-08-02", 1)], error: null } },
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: { start_date: "2026-08-02", car_model_id: "car-1", driver_lang: "zh" }, // 无 end_date / date
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  test("单日兼容语义: 只传 date 时，start_date 与 end_date 均等于 date（真正的单日退化路径）", async () => {
    const supabase = createMockSupabase({
      from: { inventory_rules_v2: { data: [row("2026-08-02", 1)], error: null } },
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({ body: { date: "2026-08-02", car_model_id: "car-1", driver_lang: "zh" } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.body.checked.start_date).toBe("2026-08-02");
    expect(res.body.checked.end_date).toBe("2026-08-02");
    expect(res.body.checked.days_count).toBe(1);
  });

  test("回归: driver_lang 传 jp（小写）与 JP 结果一致", async () => {
    const fixture = { data: [row("2026-08-02", 1)], error: null };
    const handlerLower = loadHandler(createMockSupabase({ from: { inventory_rules_v2: fixture } }));
    const handlerUpper = loadHandler(createMockSupabase({ from: { inventory_rules_v2: fixture } }));

    const reqLower = createMockReq({ body: { date: "2026-08-02", car_model_id: "car-1", driver_lang: "jp" } });
    const resLower = createMockRes();
    await handlerLower(reqLower, resLower);

    const reqUpper = createMockReq({ body: { date: "2026-08-02", car_model_id: "car-1", driver_lang: "JP" } });
    const resUpper = createMockRes();
    await handlerUpper(reqUpper, resUpper);

    expect(resLower.body.ok).toBe(resUpper.body.ok);
  });

  test("回归: end_date < start_date 返回 400", async () => {
    const supabase = createMockSupabase({ from: { inventory_rules_v2: { data: [], error: null } } });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: { start_date: "2026-08-05", end_date: "2026-08-02", car_model_id: "car-1", driver_lang: "zh" },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  test("回归: 参数缺失返回 400，不猜测", async () => {
    const supabase = createMockSupabase({ from: { inventory_rules_v2: { data: [], error: null } } });
    const handler = loadHandler(supabase);

    const req = createMockReq({ body: { car_model_id: "car-1" } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  test("数据库错误不泄露详情", async () => {
    const supabase = createMockSupabase({
      from: { inventory_rules_v2: { data: null, error: { message: "internal secret detail" } } },
    });
    const handler = loadHandler(supabase);

    const req = createMockReq({
      body: { start_date: "2026-08-02", end_date: "2026-08-05", car_model_id: "car-1", driver_lang: "zh" },
    });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/internal secret detail/);
  });

  test("非 POST 请求返回 405", async () => {
    const supabase = createMockSupabase({ from: { inventory_rules_v2: { data: [], error: null } } });
    const handler = loadHandler(supabase);

    const req = createMockReq({ method: "GET" });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(405);
  });
});
