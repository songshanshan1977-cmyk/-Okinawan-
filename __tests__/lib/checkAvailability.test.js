const { checkAvailability } = require("../../lib/inventory/checkAvailability");
const { createMockSupabase } = require("../helpers/mockSupabase");

const CAR = "car-uuid-1";

function row(date, remaining) {
  return { date, remaining_qty_calc: remaining };
}

describe("checkAvailability — 冻结规则 4.1/4.2/4.3", () => {
  test("case 03: 2~5日全部有车 -> available:true, unavailable_dates:[]", async () => {
    const supabase = createMockSupabase({
      from: {
        inventory_rules_v2: {
          data: [
            row("2026-08-02", 3),
            row("2026-08-03", 2),
            row("2026-08-04", 1),
            row("2026-08-05", 5),
          ],
          error: null,
        },
      },
    });

    const result = await checkAvailability({
      supabase,
      start_date: "2026-08-02",
      end_date: "2026-08-05",
      car_model_id: CAR,
      driver_lang: "zh",
    });

    expect(result.ok).toBe(true);
    expect(result.available).toBe(true);
    expect(result.unavailable_dates).toEqual([]);
    expect(result.checked.days_count).toBe(4);
  });

  test("case 04: 其中一天 total_qty=0 (remaining=0) -> reason sold_out", async () => {
    const supabase = createMockSupabase({
      from: {
        inventory_rules_v2: {
          data: [
            row("2026-08-02", 3),
            row("2026-08-03", 0), // total_qty=0 场景，视图直接算出 remaining=0
            row("2026-08-04", 1),
            row("2026-08-05", 5),
          ],
          error: null,
        },
      },
    });

    const result = await checkAvailability({
      supabase,
      start_date: "2026-08-02",
      end_date: "2026-08-05",
      car_model_id: CAR,
      driver_lang: "ZH",
    });

    expect(result.available).toBe(false);
    expect(result.unavailable_dates).toEqual([{ date: "2026-08-03", reason: "sold_out" }]);
  });

  test("case 05: 库存行缺失 -> reason inventory_missing，且视为可用量0", async () => {
    const supabase = createMockSupabase({
      from: {
        inventory_rules_v2: {
          // 只返回 3 天的数据，缺 2026-08-04 这一行
          data: [row("2026-08-02", 3), row("2026-08-03", 2), row("2026-08-05", 5)],
          error: null,
        },
      },
    });

    const result = await checkAvailability({
      supabase,
      start_date: "2026-08-02",
      end_date: "2026-08-05",
      car_model_id: CAR,
      driver_lang: "zh",
    });

    expect(result.available).toBe(false);
    expect(result.unavailable_dates).toEqual([{ date: "2026-08-04", reason: "inventory_missing" }]);
    expect(result.min_remaining).toBe(0);
  });

  test("case 06: 一天被 locked 占满 (视图已扣减 locked_qty，remaining<=0) -> reason sold_out", async () => {
    // inventory_rules_v2 视图定义 = GREATEST(total_qty - booked_qty - locked_qty, 0)
    // 从 checkAvailability 的角度看，locked 占满和 total_qty=0 表现完全一致：remaining<=0。
    const supabase = createMockSupabase({
      from: {
        inventory_rules_v2: {
          data: [
            row("2026-08-02", 2),
            row("2026-08-03", 2),
            row("2026-08-04", 2),
            row("2026-08-05", 0), // total_qty=1,booked=0,locked=1 => remaining=0
          ],
          error: null,
        },
      },
    });

    const result = await checkAvailability({
      supabase,
      start_date: "2026-08-02",
      end_date: "2026-08-05",
      car_model_id: CAR,
      driver_lang: "zh",
    });

    expect(result.available).toBe(false);
    expect(result.unavailable_dates).toEqual([{ date: "2026-08-05", reason: "sold_out" }]);
  });

  test("case 08: 多个不可用日期，返回升序、无重复", async () => {
    const supabase = createMockSupabase({
      from: {
        inventory_rules_v2: {
          data: [row("2026-08-02", 1), row("2026-08-04", 1)], // 缺 03/05
          error: null,
        },
      },
    });

    const result = await checkAvailability({
      supabase,
      start_date: "2026-08-02",
      end_date: "2026-08-05",
      car_model_id: CAR,
      driver_lang: "zh",
    });

    const dates = result.unavailable_dates.map((d) => d.date);
    expect(dates).toEqual(["2026-08-03", "2026-08-05"]); // 升序
    expect(new Set(dates).size).toBe(dates.length); // 无重复
  });

  test("driver_lang zh/jp 与 ZH/JP 结果一致（大小写标准化）", async () => {
    const fixture = { data: [row("2026-08-02", 3)], error: null };
    const supabaseLower = createMockSupabase({ from: { inventory_rules_v2: fixture } });
    const supabaseUpper = createMockSupabase({ from: { inventory_rules_v2: fixture } });

    const a = await checkAvailability({
      supabase: supabaseLower,
      start_date: "2026-08-02",
      end_date: "2026-08-02",
      car_model_id: CAR,
      driver_lang: "zh",
    });
    const b = await checkAvailability({
      supabase: supabaseUpper,
      start_date: "2026-08-02",
      end_date: "2026-08-02",
      car_model_id: CAR,
      driver_lang: "ZH",
    });

    expect(a.available).toBe(b.available);
    expect(supabaseLower.__calls.from).toContain("inventory_rules_v2");
  });

  test("回归: end_date < start_date 返回 400 invalid_request", async () => {
    const supabase = createMockSupabase({ from: { inventory_rules_v2: { data: [], error: null } } });

    const result = await checkAvailability({
      supabase,
      start_date: "2026-08-05",
      end_date: "2026-08-02",
      car_model_id: CAR,
      driver_lang: "zh",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toBe("invalid_request");
  });

  test("回归: 缺少必填参数返回 400 invalid_request", async () => {
    const supabase = createMockSupabase({ from: { inventory_rules_v2: { data: [], error: null } } });

    const result = await checkAvailability({
      supabase,
      start_date: "2026-08-02",
      end_date: "2026-08-05",
      car_model_id: CAR,
      driver_lang: "fr", // 非法语言
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  test("数据库查询出错时不泄露详情，返回 500 inventory_check_failed", async () => {
    const supabase = createMockSupabase({
      from: { inventory_rules_v2: { data: null, error: { message: "connection refused: 10.0.0.5:5432" } } },
    });

    const result = await checkAvailability({
      supabase,
      start_date: "2026-08-02",
      end_date: "2026-08-05",
      car_model_id: CAR,
      driver_lang: "zh",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toBe("inventory_check_failed");
    expect(JSON.stringify(result)).not.toMatch(/10\.0\.0\.5/);
  });
});
