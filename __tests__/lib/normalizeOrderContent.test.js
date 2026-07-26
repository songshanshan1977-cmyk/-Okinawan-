const { buildNormalizedContent, contentsEqual, normalizeDriverLang, FIXED_DEPOSIT_AMOUNT } = require("../../lib/orders/normalizeOrderContent");
const { createMockSupabase } = require("../helpers/mockSupabase");

const ECONOMY = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";

const BASE_RAW = {
  start_date: "2026-08-02",
  end_date: "2026-08-05",
  departure_hotel: "Hotel A",
  end_hotel: "Hotel B",
  car_model_id: ECONOMY,
  driver_lang: "zh",
  duration: 8,
  pax: 2,
  luggage: 1,
  name: "Test User",
  phone: "080-1111-2222",
  email: "a@b.com",
  wechat: "",
  itinerary: "",
  remark: "",
  source: "direct",
};

describe("buildNormalizedContent", () => {
  test("driver_lang 规范化为 ZH/JP，duration 转数字，deposit_amount 固定为 500", async () => {
    const supabase = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });
    const result = await buildNormalizedContent({ supabase, raw: BASE_RAW });

    expect(result.ok).toBe(true);
    expect(result.content.driver_lang).toBe("ZH");
    expect(result.content.duration).toBe(8);
    expect(result.content.deposit_amount).toBe(FIXED_DEPOSIT_AMOUNT);
    expect(result.content.total_price).toBe(1600 * 4);
  });

  test("传入 knownTotalPrice 时跳过 RPC 查价", async () => {
    const rpcSpy = jest.fn();
    const supabase = createMockSupabase({ from: {}, rpc: rpcSpy });
    const result = await buildNormalizedContent({ supabase, raw: BASE_RAW, knownTotalPrice: 9999 });

    expect(result.ok).toBe(true);
    expect(result.content.total_price).toBe(9999);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  test("undefined 字段规范化为 null（与写库规则一致，不额外 trim）", async () => {
    const supabase = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });
    const raw = { ...BASE_RAW };
    delete raw.wechat;
    delete raw.itinerary;

    const result = await buildNormalizedContent({ supabase, raw });
    expect(result.content.wechat).toBeNull();
    expect(result.content.itinerary).toBeNull();
  });

  test("底层价格不可用时拒绝（不猜测/不兜底）", async () => {
    const supabase = createMockSupabase({ from: {}, rpc: () => ({ data: null, error: null }) });
    const result = await buildNormalizedContent({ supabase, raw: BASE_RAW });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("price_unavailable");
  });
});

describe("contentsEqual", () => {
  test("完全相同的规范化内容判定相等", async () => {
    const supabase1 = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });
    const supabase2 = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });
    const a = await buildNormalizedContent({ supabase: supabase1, raw: BASE_RAW });
    const b = await buildNormalizedContent({ supabase: supabase2, raw: { ...BASE_RAW } });
    expect(contentsEqual(a.content, b.content)).toBe(true);
  });

  test("任意一个业务字段不同即判定不相等（如 start_date）", async () => {
    const supabase1 = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });
    const supabase2 = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });
    const a = await buildNormalizedContent({ supabase: supabase1, raw: BASE_RAW });
    const b = await buildNormalizedContent({ supabase: supabase2, raw: { ...BASE_RAW, start_date: "2026-09-01" } });
    expect(contentsEqual(a.content, b.content)).toBe(false);
  });

  test("driver_lang 大小写不同但规范化后相同 -> 判定相等", async () => {
    const supabase1 = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });
    const supabase2 = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });
    const a = await buildNormalizedContent({ supabase: supabase1, raw: { ...BASE_RAW, driver_lang: "zh" } });
    const b = await buildNormalizedContent({ supabase: supabase2, raw: { ...BASE_RAW, driver_lang: "ZH" } });
    expect(contentsEqual(a.content, b.content)).toBe(true);
  });

  test("客户端 total_price 不参与比较（buildNormalizedContent 根本不读取该字段）", async () => {
    const supabase1 = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });
    const supabase2 = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });
    const a = await buildNormalizedContent({ supabase: supabase1, raw: { ...BASE_RAW, total_price: 1 } });
    const b = await buildNormalizedContent({ supabase: supabase2, raw: { ...BASE_RAW, total_price: 999999 } });
    expect(contentsEqual(a.content, b.content)).toBe(true);
    expect(a.content.total_price).toBe(1600 * 4); // 服务端重算值，不是 1 也不是 999999
  });
});

describe("normalizeDriverLang", () => {
  test.each([
    ["zh", "ZH"],
    ["ZH", "ZH"],
    ["jp", "JP"],
    ["ja", "JP"],
    ["jpn", "JP"],
    ["JP", "JP"],
    [undefined, "ZH"],
    ["", "ZH"],
    ["fr", "ZH"], // 兜底
  ])("normalizeDriverLang(%s) -> %s", (input, expected) => {
    expect(normalizeDriverLang(input)).toBe(expected);
  });
});
