const { checkAvailability } = require("../../lib/inventory/checkAvailability");
const { createMockSupabase } = require("../helpers/mockSupabase");

// case 12: 人工页面（Step2 → check-inventory.js）与未来 Agent（预期会走同一个
// checkAvailability 共享模块）在相同输入下必须得到完全相同的 unavailable_dates。
// 因为 check-inventory.js 和 create-payment-intent.js 都不重新实现库存判断逻辑，
// 而是共同调用这一个模块，这个等价性在结构上就是保证的——这里用相同 fixture
// 分别驱动两次独立调用来验证输出字节级一致，作为该结构性保证的回归测试。
describe("case 12: 共享 checkAvailability 模块 —— 任意调用方相同输入得相同输出", () => {
  test("两次独立调用（模拟人工页面 vs 未来 Agent）返回完全相同的 unavailable_dates", async () => {
    const fixture = {
      data: [
        { date: "2026-08-02", remaining_qty_calc: 2 },
        { date: "2026-08-04", remaining_qty_calc: 0 },
      ],
      error: null,
    };

    const humanPageCallSupabase = createMockSupabase({ from: { inventory_rules_v2: fixture } });
    const agentCallSupabase = createMockSupabase({ from: { inventory_rules_v2: fixture } });

    const input = {
      start_date: "2026-08-02",
      end_date: "2026-08-05",
      car_model_id: "car-1",
      driver_lang: "zh", // 人工页面习惯传小写
    };
    const agentInput = { ...input, driver_lang: "ZH" }; // Agent 假设传大写，规范化后应等价

    const humanResult = await checkAvailability({ supabase: humanPageCallSupabase, ...input });
    const agentResult = await checkAvailability({ supabase: agentCallSupabase, ...agentInput });

    expect(agentResult.unavailable_dates).toEqual(humanResult.unavailable_dates);
    expect(agentResult.available).toBe(humanResult.available);
    expect(agentResult.checked).toEqual(humanResult.checked);
  });
});
