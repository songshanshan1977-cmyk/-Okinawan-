const { createMockSupabase } = require("../../helpers/mockSupabase");
const { createMockRes } = require("../../helpers/mockReqRes");

function loadHandler(supabase) {
  let handler;
  jest.isolateModules(() => {
    jest.doMock("@supabase/supabase-js", () => ({ createClient: jest.fn(() => supabase) }));
    const mod = require("../../../pages/api/agent/check-availability");
    handler = mod.default || mod;
  });
  return handler;
}

const CAR = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";

describe("pages/api/agent/check-availability", () => {
  const ORIGINAL_KEY = process.env.AGENT_SERVICE_KEY;
  beforeEach(() => {
    process.env.AGENT_SERVICE_KEY = "test-service-key";
  });
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.AGENT_SERVICE_KEY;
    else process.env.AGENT_SERVICE_KEY = ORIGINAL_KEY;
  });

  test("non-POST method -> 405", async () => {
    const supabase = createMockSupabase({ from: {} });
    const handler = loadHandler(supabase);
    const req = { method: "GET", headers: {}, body: {} };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  test("missing Authorization header -> 401 agent_unauthorized", async () => {
    const supabase = createMockSupabase({ from: {} });
    const handler = loadHandler(supabase);
    const req = { method: "POST", headers: {}, body: {} };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ ok: false, error: "agent_unauthorized" });
  });

  test("AGENT_SERVICE_KEY not configured -> 500 agent_auth_not_configured", async () => {
    delete process.env.AGENT_SERVICE_KEY;
    const supabase = createMockSupabase({ from: {} });
    const handler = loadHandler(supabase);
    const req = { method: "POST", headers: { authorization: "Bearer whatever" }, body: {} };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("agent_auth_not_configured");
  });

  test("valid auth + valid params -> 200 with the exact whitelist shape", async () => {
    const supabase = createMockSupabase({
      from: { inventory_rules_v2: { data: [{ date: "2026-09-01", remaining_qty_calc: 2 }], error: null } },
    });
    const handler = loadHandler(supabase);
    const req = {
      method: "POST",
      headers: { authorization: "Bearer test-service-key" },
      body: { start_date: "2026-09-01", end_date: "2026-09-01", car_model_id: CAR, driver_lang: "zh" },
    };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["available", "checked", "min_remaining", "ok", "unavailable_dates"].sort());
  });

  test("invalid driver_lang -> 400 invalid_request", async () => {
    const supabase = createMockSupabase({ from: { inventory_rules_v2: { data: [], error: null } } });
    const handler = loadHandler(supabase);
    const req = {
      method: "POST",
      headers: { authorization: "Bearer test-service-key" },
      body: { start_date: "2026-09-01", end_date: "2026-09-01", car_model_id: CAR, driver_lang: "fr" },
    };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  test("no CORS header is ever set on the response", async () => {
    const supabase = createMockSupabase({ from: { inventory_rules_v2: { data: [], error: null } } });
    const handler = loadHandler(supabase);
    const req = { method: "POST", headers: { authorization: "Bearer test-service-key" }, body: { car_model_id: CAR, driver_lang: "zh", start_date: "2026-09-01", end_date: "2026-09-01" } };
    const res = createMockRes();
    res.setHeader = jest.fn();
    await handler(req, res);
    expect(res.setHeader).not.toHaveBeenCalledWith("Access-Control-Allow-Origin", expect.anything());
  });
});
