const { calcTotalPrice, calcDays } = require("../../lib/pricing/calcTotalPrice");
const { createMockSupabase } = require("../helpers/mockSupabase");

describe("calcTotalPrice — 服务端价格重算（不信任客户端 total_price）", () => {
  test("首日单价 x 天数（与现有 Step2 定价模型一致）", async () => {
    const supabase = createMockSupabase({
      from: {},
      rpc: () => ({ data: 1600, error: null }), // get_car_price 返回每日 1600
    });

    const result = await calcTotalPrice({
      supabase,
      car_model_id: "car-1",
      driver_lang: "ZH",
      duration: 8,
      start_date: "2026-08-02",
      end_date: "2026-08-05",
    });

    expect(result.ok).toBe(true);
    expect(result.days).toBe(4);
    expect(result.total_price).toBe(1600 * 4);
    expect(supabase.rpc).toHaveBeenCalledWith("get_car_price", {
      p_car_model_id: "car-1",
      p_driver_lang: "ZH",
      p_duration_hours: 8,
      p_use_date: "2026-08-02",
    });
  });

  test("单日订单 end_date 缺省时按 1 天计算", async () => {
    const supabase = createMockSupabase({ from: {}, rpc: () => ({ data: 1300, error: null }) });

    const result = await calcTotalPrice({
      supabase,
      car_model_id: "car-1",
      driver_lang: "JP",
      duration: 10,
      start_date: "2026-08-02",
      end_date: "2026-08-02",
    });

    expect(result.days).toBe(1);
    expect(result.total_price).toBe(1300);
  });

  test("RPC 报错时不猜测价格，直接失败", async () => {
    const supabase = createMockSupabase({
      from: {},
      rpc: () => ({ data: null, error: { message: "boom" } }),
    });

    const result = await calcTotalPrice({
      supabase,
      car_model_id: "car-1",
      driver_lang: "ZH",
      duration: 8,
      start_date: "2026-08-02",
      end_date: "2026-08-02",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("price_lookup_failed");
  });

  test("价格为 0/null 时视为不可用，不放行 0 元订单", async () => {
    const supabase = createMockSupabase({ from: {}, rpc: () => ({ data: null, error: null }) });

    const result = await calcTotalPrice({
      supabase,
      car_model_id: "car-1",
      driver_lang: "ZH",
      duration: 8,
      start_date: "2026-08-02",
      end_date: "2026-08-02",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("price_unavailable");
  });
});

describe("calcDays", () => {
  test("含首尾日计数", () => {
    expect(calcDays("2026-08-02", "2026-08-05")).toBe(4);
    expect(calcDays("2026-08-02", "2026-08-02")).toBe(1);
  });
});
