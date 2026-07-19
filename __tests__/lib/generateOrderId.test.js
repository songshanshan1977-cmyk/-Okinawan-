const crypto = require("crypto");
const { generateOrderId, insertNewDraftWithRetry } = require("../../lib/orders/generateOrderId");
const { createMockSupabase } = require("../helpers/mockSupabase");

const SAMPLE_CONTENT = {
  start_date: "2026-08-02",
  end_date: "2026-08-05",
  car_model_id: "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca",
  driver_lang: "ZH",
  duration: 8,
  total_price: 6400,
  deposit_amount: 500,
};

describe("generateOrderId", () => {
  test("格式为 ORD-YYYYMMDD-NNNNN，日期使用 UTC（与既有前端生成逻辑一致）", () => {
    const id = generateOrderId();
    expect(id).toMatch(/^ORD-\d{8}-\d{5}$/);
    const expectedDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    expect(id).toContain(`ORD-${expectedDate}-`);
  });

  test("使用 crypto 安全随机数，而非 Math.random()", () => {
    const spy = jest.spyOn(crypto, "randomInt");
    const mathRandomSpy = jest.spyOn(Math, "random");
    generateOrderId();
    expect(spy).toHaveBeenCalledWith(10000, 100000);
    expect(mathRandomSpy).not.toHaveBeenCalled();
    spy.mockRestore();
    mathRandomSpy.mockRestore();
  });
});

describe("insertNewDraftWithRetry", () => {
  test("首次插入成功：只调用一次，返回新订单", async () => {
    const newRow = { order_id: "ORD-20260719-11111", ...SAMPLE_CONTENT };
    const supabase = createMockSupabase({ from: { orders: { data: newRow, error: null } } });

    const result = await insertNewDraftWithRetry({ supabase, content: SAMPLE_CONTENT });

    expect(result.ok).toBe(true);
    expect(result.order).toEqual(newRow);
    expect(supabase.__calls.from.filter((t) => t === "orders").length).toBe(1);
  });

  test("case 05: 第一次唯一冲突，第二次成功 -> 最终返回第二个新ID，重试次数受限", async () => {
    const newRow = { order_id: "ORD-20260719-22222", ...SAMPLE_CONTENT };
    const supabase = createMockSupabase({
      from: {
        orders: [
          { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } },
          { data: newRow, error: null },
        ],
      },
    });

    const result = await insertNewDraftWithRetry({ supabase, content: SAMPLE_CONTENT, maxAttempts: 3 });

    expect(result.ok).toBe(true);
    expect(result.order).toEqual(newRow);
    expect(supabase.__calls.from.filter((t) => t === "orders").length).toBe(2); // 恰好重试了1次
  });

  test("连续命中唯一冲突超过重试次数 -> 500 order_id_generation_failed，不泄露详情", async () => {
    const conflictResult = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint on column order_id" } };
    const supabase = createMockSupabase({
      from: { orders: [conflictResult, conflictResult, conflictResult] },
    });

    const result = await insertNewDraftWithRetry({ supabase, content: SAMPLE_CONTENT, maxAttempts: 3 });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("order_id_generation_failed");
    expect(JSON.stringify(result)).not.toMatch(/duplicate key/);
    expect(supabase.__calls.from.filter((t) => t === "orders").length).toBe(3); // 恰好用满3次重试，不多不少
  });

  test("非唯一冲突的数据库错误：不重试，立即安全失败", async () => {
    const supabase = createMockSupabase({
      from: { orders: { data: null, error: { code: "53300", message: "too many connections at 10.0.0.9" } } },
    });

    const result = await insertNewDraftWithRetry({ supabase, content: SAMPLE_CONTENT, maxAttempts: 3 });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("order_creation_failed");
    expect(JSON.stringify(result)).not.toMatch(/10\.0\.0\.9/);
    expect(supabase.__calls.from.filter((t) => t === "orders").length).toBe(1); // 未重试
  });

  test("插入内容里没有客户端可控的 order_id 字段（服务端生成，覆盖任何 content.order_id）", async () => {
    const newRow = { order_id: "ORD-20260719-33333", ...SAMPLE_CONTENT };
    const supabase = createMockSupabase({ from: { orders: { data: newRow, error: null } } });

    // 即使 content 里混入一个 order_id（不应该发生，但防御性验证）
    await insertNewDraftWithRetry({ supabase, content: { ...SAMPLE_CONTENT, order_id: "ATTACKER-CHOSEN-ID" } });

    const insertCall = supabase.__tableCalls.orders.insert.mock.calls[0][0][0];
    // 服务端生成的 order_id 必须覆盖 content 里携带的任何同名字段（对象字面量展开顺序：order_id 在前，...content 在后会覆盖它——
    // 这里验证的是最终真正调用 insert 时的 order_id 不是攻击者提供的值）
    expect(insertCall.order_id).not.toBe("ATTACKER-CHOSEN-ID");
    expect(insertCall.order_id).toMatch(/^ORD-\d{8}-\d{5}$/);
  });
});
