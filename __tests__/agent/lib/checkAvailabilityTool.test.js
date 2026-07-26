const { checkAvailabilityTool } = require("../../../lib/agent/tools/checkAvailability");
const { createMockSupabase } = require("../../helpers/mockSupabase");
const { AGENT_ERROR_CODES } = require("../../../lib/agent/errorCodes");

const CAR = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";

describe("checkAvailabilityTool", () => {
  test("delegates to PR#1 checkAvailability and passes its success shape straight through", async () => {
    const supabase = createMockSupabase({
      from: { inventory_rules_v2: { data: [{ date: "2026-09-01", remaining_qty_calc: 3 }], error: null } },
    });

    const result = await checkAvailabilityTool({
      supabase,
      start_date: "2026-09-01",
      end_date: "2026-09-01",
      car_model_id: CAR,
      driver_lang: "zh",
    });

    expect(result).toEqual({
      ok: true,
      available: true,
      unavailable_dates: [],
      min_remaining: 3,
      checked: { start_date: "2026-09-01", end_date: "2026-09-01", days_count: 1 },
    });
  });

  test("strict language rule: missing driver_lang is NOT defaulted to ZH, rejected as invalid_request", async () => {
    const supabase = createMockSupabase({ from: { inventory_rules_v2: { data: [], error: null } } });

    const result = await checkAvailabilityTool({
      supabase,
      start_date: "2026-09-01",
      end_date: "2026-09-01",
      car_model_id: CAR,
      driver_lang: undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
  });

  test("strict language rule: an invalid language string is rejected, not silently coerced", async () => {
    const supabase = createMockSupabase({ from: { inventory_rules_v2: { data: [], error: null } } });

    const result = await checkAvailabilityTool({
      supabase,
      start_date: "2026-09-01",
      end_date: "2026-09-01",
      car_model_id: CAR,
      driver_lang: "fr",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
  });

  test("lowercase zh/jp are normalized and accepted (compatible casing)", async () => {
    const supabase = createMockSupabase({
      from: { inventory_rules_v2: { data: [{ date: "2026-09-01", remaining_qty_calc: 1 }], error: null } },
    });

    const result = await checkAvailabilityTool({
      supabase,
      start_date: "2026-09-01",
      end_date: "2026-09-01",
      car_model_id: CAR,
      driver_lang: "jp",
    });

    expect(result.ok).toBe(true);
  });

  test("database error maps to inventory_check_failed and leaks no error detail", async () => {
    const supabase = createMockSupabase({
      from: { inventory_rules_v2: { data: null, error: { message: "connection refused: 10.0.0.7:5432" } } },
    });

    const result = await checkAvailabilityTool({
      supabase,
      start_date: "2026-09-01",
      end_date: "2026-09-01",
      car_model_id: CAR,
      driver_lang: "zh",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(AGENT_ERROR_CODES.INVENTORY_CHECK_FAILED);
    expect(JSON.stringify(result)).not.toMatch(/10\.0\.0\.7/);
  });
});
