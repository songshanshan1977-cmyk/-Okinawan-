const { calcTotalPrice, calcDays } = require("../../lib/pricing/calcTotalPrice");
const { createMockSupabase } = require("../helpers/mockSupabase");

// 三个正式车型 UUID（来自 components/BookingFlow.jsx CAR_MODEL_IDS）
const ECONOMY = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca"; // 经济 5 座轿车
const ALPHARD = "82cf604f-e688-49fe-aecf-69894a01f6cb"; // 豪华 7 座阿尔法
const HIACE = "453df662-d350-4ab9-b811-61ffcda40d4b"; // 舒适 10 座海狮

describe("calcTotalPrice — 服务端价格重算（不信任客户端 total_price）", () => {
  test("首日单价 x 天数（与现有 Step2 定价模型一致）", async () => {
    const supabase = createMockSupabase({
      from: {},
      rpc: () => ({ data: 1600, error: null }), // get_car_price 返回每日 1600
    });

    const result = await calcTotalPrice({
      supabase,
      car_model_id: ECONOMY,
      driver_lang: "ZH",
      duration: 8,
      start_date: "2026-08-02",
      end_date: "2026-08-05",
    });

    expect(result.ok).toBe(true);
    expect(result.days).toBe(4);
    expect(result.total_price).toBe(1600 * 4);
    expect(supabase.rpc).toHaveBeenCalledWith("get_car_price", {
      p_car_model_id: ECONOMY,
      p_driver_lang: "ZH",
      p_duration_hours: 8,
      p_use_date: "2026-08-02",
    });
  });

  test("单日订单 end_date 缺省时按 1 天计算", async () => {
    const supabase = createMockSupabase({ from: {}, rpc: () => ({ data: 1300, error: null }) });

    const result = await calcTotalPrice({
      supabase,
      car_model_id: ECONOMY,
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
      car_model_id: ECONOMY,
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
      car_model_id: ECONOMY,
      driver_lang: "ZH",
      duration: 8,
      start_date: "2026-08-02",
      end_date: "2026-08-02",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("price_unavailable");
  });

  // ────────────────────────────────────────────────────────────
  // 任务二：校验规则
  // ────────────────────────────────────────────────────────────

  test("duration 只能是 8 或 10，非法值直接拒绝（不查价，不猜测）", async () => {
    const rpcSpy = jest.fn(() => ({ data: 1600, error: null }));
    const supabase = createMockSupabase({ from: {}, rpc: rpcSpy });

    const result = await calcTotalPrice({
      supabase,
      car_model_id: ECONOMY,
      driver_lang: "ZH",
      duration: 9, // 非法
      start_date: "2026-08-02",
      end_date: "2026-08-02",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_duration");
    expect(rpcSpy).not.toHaveBeenCalled(); // 不该发生任何查价请求
  });

  test("car_model_id 必须是当前三个正式车型之一，未知UUID直接拒绝", async () => {
    const rpcSpy = jest.fn(() => ({ data: 1600, error: null }));
    const supabase = createMockSupabase({ from: {}, rpc: rpcSpy });

    const result = await calcTotalPrice({
      supabase,
      car_model_id: "11111111-1111-1111-1111-111111111111", // 不是三个正式车型之一
      driver_lang: "ZH",
      duration: 8,
      start_date: "2026-08-02",
      end_date: "2026-08-02",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_car_model");
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  test("driver_lang 必须规范化为 ZH/JP，其他值直接拒绝", async () => {
    const rpcSpy = jest.fn(() => ({ data: 1600, error: null }));
    const supabase = createMockSupabase({ from: {}, rpc: rpcSpy });

    const result = await calcTotalPrice({
      supabase,
      car_model_id: ECONOMY,
      driver_lang: "FR", // 既不是 ZH 也不是 JP
      duration: 8,
      start_date: "2026-08-02",
      end_date: "2026-08-02",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_driver_lang");
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  test("driver_lang 大小写不敏感：zh/ZH 都能通过校验（大小写规范化）", async () => {
    const supabase = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });

    const result = await calcTotalPrice({
      supabase,
      car_model_id: ECONOMY,
      driver_lang: "zh",
      duration: 8,
      start_date: "2026-08-02",
      end_date: "2026-08-02",
    });

    expect(result.ok).toBe(true);
  });

  // ────────────────────────────────────────────────────────────
  // 任务二 第9条：当前正式价格覆盖（价格数据本身来自 mock 的 get_car_price RPC，
  // 不是本模块硬编码——这里只是模拟"如果线上正式价格就是这些数字，计算结果应该对"）
  // ────────────────────────────────────────────────────────────

  const OFFICIAL_PRICES = [
    ["经济5座", ECONOMY, "ZH", 8, 1600],
    ["经济5座", ECONOMY, "ZH", 10, 1800],
    ["经济5座", ECONOMY, "JP", 8, 1300],
    ["经济5座", ECONOMY, "JP", 10, 1500],
    ["阿尔法7座", ALPHARD, "ZH", 8, 1800],
    ["阿尔法7座", ALPHARD, "ZH", 10, 2000],
    ["阿尔法7座", ALPHARD, "JP", 8, 1700],
    ["阿尔法7座", ALPHARD, "JP", 10, 1900],
    ["海狮10座", HIACE, "ZH", 8, 2100],
    ["海狮10座", HIACE, "ZH", 10, 2300],
    ["海狮10座", HIACE, "JP", 8, 2000],
    ["海狮10座", HIACE, "JP", 10, 2200],
  ];

  test.each(OFFICIAL_PRICES)(
    "%s / %s / %s / %sh -> RPC 返回当前正式单日价 %i 时，calcTotalPrice 正确透传（不重新维护一份价格表）",
    async (_name, carModelId, driverLang, duration, dailyPrice) => {
      const rpcSpy = jest.fn(() => ({ data: dailyPrice, error: null }));
      const supabase = createMockSupabase({ from: {}, rpc: rpcSpy });

      const result = await calcTotalPrice({
        supabase,
        car_model_id: carModelId,
        driver_lang: driverLang,
        duration,
        start_date: "2026-08-02",
        end_date: "2026-08-02",
      });

      expect(result.ok).toBe(true);
      expect(result.total_price).toBe(dailyPrice); // 单日，1天
      expect(rpcSpy).toHaveBeenCalledWith(
        "get_car_price",
        expect.objectContaining({
          p_car_model_id: carModelId,
          p_driver_lang: driverLang,
          p_duration_hours: duration,
        })
      );
    }
  );

  test("客户端提交 total_price=1 时，服务端仍按 RPC 返回的正式价格写入，不采用客户端值", async () => {
    // calcTotalPrice 本身不接收 total_price 参数——这正是"不信任客户端"的实现方式：
    // 它压根不读取客户端传来的 total_price，只用 car/lang/duration/date 重新查价。
    const supabase = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });

    const clientFakedInput = {
      supabase,
      car_model_id: ECONOMY,
      driver_lang: "ZH",
      duration: 8,
      start_date: "2026-08-02",
      end_date: "2026-08-02",
      total_price: 1, // 即使传了，函数签名也不使用这个字段
    };

    const result = await calcTotalPrice(clientFakedInput);
    expect(result.total_price).toBe(1600);
    expect(result.total_price).not.toBe(1);
  });

  test("本模块不维护硬编码价格表：车型/时长的合法值来自白名单（只校验形状），价格数值 100% 来自 RPC", () => {
    const calcTotalPriceModule = require("../../lib/pricing/calcTotalPrice");
    const source = require("fs").readFileSync(
      require.resolve("../../lib/pricing/calcTotalPrice"),
      "utf8"
    );
    // 源码里不应出现任何具体价格数字（1600/1800/2100 等）
    for (const price of [1600, 1800, 1300, 1500, 2000, 1700, 1900, 2100, 2300, 2200]) {
      expect(source).not.toMatch(new RegExp(String(price)));
    }
    expect(typeof calcTotalPriceModule.calcTotalPrice).toBe("function");
  });
});

describe("calcDays", () => {
  test("含首尾日计数", () => {
    expect(calcDays("2026-08-02", "2026-08-05")).toBe(4);
    expect(calcDays("2026-08-02", "2026-08-02")).toBe(1);
  });
});
