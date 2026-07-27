const { createMockSupabase } = require("../../helpers/mockSupabase");
const { createMockRes } = require("../../helpers/mockReqRes");

function loadHandler(supabase) {
  let handler;
  jest.isolateModules(() => {
    jest.doMock("@supabase/supabase-js", () => ({ createClient: jest.fn(() => supabase) }));
    const mod = require("../../../pages/api/agent/calculate-quote");
    handler = mod.default || mod;
  });
  return handler;
}

const CAR = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";

describe("pages/api/agent/calculate-quote", () => {
  beforeEach(() => {
    process.env.AGENT_SERVICE_KEY = "test-service-key-0123456789abcdef";
  });
  afterEach(() => {
    delete process.env.AGENT_SERVICE_KEY;
  });

  test("wrong service key -> 401 agent_unauthorized", async () => {
    const supabase = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });
    const handler = loadHandler(supabase);
    const req = { method: "POST", headers: { authorization: "Bearer wrong" }, body: {} };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  test("ignores a caller-supplied price entirely and returns only the RPC-derived quote", async () => {
    const supabase = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });
    const handler = loadHandler(supabase);
    const req = {
      method: "POST",
      headers: { authorization: "Bearer test-service-key-0123456789abcdef" },
      body: { start_date: "2026-09-01", end_date: "2026-09-01", car_model_id: CAR, driver_lang: "ZH", duration: 8, total_price: 1 },
    };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.total_price).toBe(1600);
    expect(res.body.deposit_amount).toBe(500);
    expect(res.body.currency).toBe("CNY");
  });

  test("output has no extra fields beyond the whitelist", async () => {
    const supabase = createMockSupabase({ from: {}, rpc: () => ({ data: 1600, error: null }) });
    const handler = loadHandler(supabase);
    const req = {
      method: "POST",
      headers: { authorization: "Bearer test-service-key-0123456789abcdef" },
      body: { start_date: "2026-09-01", end_date: "2026-09-01", car_model_id: CAR, driver_lang: "ZH", duration: 8 },
    };
    const res = createMockRes();
    await handler(req, res);
    expect(Object.keys(res.body).sort()).toEqual(["balance_due", "currency", "days_count", "deposit_amount", "ok", "total_price"].sort());
  });
});
