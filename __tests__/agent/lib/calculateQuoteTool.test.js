const { calculateQuoteTool } = require("../../../lib/agent/tools/calculateQuote");
const { createMockSupabase } = require("../../helpers/mockSupabase");
const { AGENT_ERROR_CODES } = require("../../../lib/agent/errorCodes");

const CAR = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";

describe("calculateQuoteTool", () => {
  test("total_price/deposit_amount/balance_due are derived ONLY from the real get_car_price RPC result, never from caller input", async () => {
    const supabase = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });

    const result = await calculateQuoteTool({
      supabase,
      start_date: "2026-09-01",
      end_date: "2026-09-04",
      car_model_id: CAR,
      driver_lang: "ZH",
      duration: 8,
      // an attacker/prompt-injected caller might try to also smuggle a price in:
      total_price: 1,
      price: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.total_price).toBe(1600 * 4);
    expect(result.deposit_amount).toBe(500);
    expect(result.balance_due).toBe(1600 * 4 - 500);
    expect(result.currency).toBe("CNY");
    expect(result.days_count).toBe(4);
    expect(supabase.rpc).toHaveBeenCalledWith("get_car_price", {
      p_car_model_id: CAR,
      p_driver_lang: "ZH",
      p_duration_hours: 8,
      p_use_date: "2026-09-01",
    });
  });

  test("invalid car_model_id -> invalid_request (shape-level rejection)", async () => {
    const supabase = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });
    const result = await calculateQuoteTool({
      supabase,
      start_date: "2026-09-01",
      end_date: "2026-09-01",
      car_model_id: "not-a-real-car",
      driver_lang: "ZH",
      duration: 8,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
  });

  test("RPC failure (upstream) -> quote_failed, not invalid_request", async () => {
    const supabase = createMockSupabase({ from: {}, rpc: () => ({ data: null, error: { message: "db down" } }) });
    const result = await calculateQuoteTool({
      supabase,
      start_date: "2026-09-01",
      end_date: "2026-09-01",
      car_model_id: CAR,
      driver_lang: "ZH",
      duration: 8,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.QUOTE_FAILED);
  });

  test("no price configured for the date (RPC returns null) -> quote_failed", async () => {
    const supabase = createMockSupabase({ from: {}, rpc: () => ({ data: null, error: null }) });
    const result = await calculateQuoteTool({
      supabase,
      start_date: "2026-09-01",
      end_date: "2026-09-01",
      car_model_id: CAR,
      driver_lang: "ZH",
      duration: 8,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.QUOTE_FAILED);
  });

  test("balance_due never goes negative even if deposit exceeded total_price", async () => {
    const supabase = createMockSupabase({ from: {}, rpc: () => ({ data: 100, error: null }) });
    const result = await calculateQuoteTool({
      supabase,
      start_date: "2026-09-01",
      end_date: "2026-09-01",
      car_model_id: CAR,
      driver_lang: "ZH",
      duration: 8,
    });
    expect(result.total_price).toBe(100);
    expect(result.balance_due).toBe(0); // max(100-500, 0)
  });
});
