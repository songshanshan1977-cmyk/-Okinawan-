const { createMockReq, createMockRes } = require("../helpers/mockReqRes");

function loadHandler() {
  const mod = require("../../pages/api/public/openapi");
  return mod.default || mod;
}

describe("GET /api/public/openapi", () => {
  test("GET succeeds, no Agent auth required, returns the full OpenAPI document", async () => {
    const handler = loadHandler();
    const req = createMockReq({ method: "GET" });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(res.body.info.title).toBe("华人Okinawa Agent Booking API");
    expect(res.body.info.version).toBe("2026-08-02-v1");
    expect(res.body.servers).toEqual([{ url: "https://booking.xn--okinawa-n14kh45a.com" }]);
    expect(Object.keys(res.body.paths)).toHaveLength(11);
  });

  test("CORS header allows any origin", async () => {
    const handler = loadHandler();
    const req = createMockReq({ method: "GET" });
    const res = createMockRes();
    await handler(req, res);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  test("Cache-Control header is public with a short max-age", async () => {
    const handler = loadHandler();
    const req = createMockReq({ method: "GET" });
    const res = createMockRes();
    await handler(req, res);
    expect(res.headers["cache-control"]).toBe("public, max-age=300, s-maxage=300");
  });

  test("Content-Type is application/json; charset=utf-8", async () => {
    const handler = loadHandler();
    const req = createMockReq({ method: "GET" });
    const res = createMockRes();
    await handler(req, res);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  test("HEAD succeeds with status 200 and an empty body (res.json is never called)", async () => {
    const handler = loadHandler();
    const req = createMockReq({ method: "HEAD" });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.json).not.toHaveBeenCalled();
    expect(res.body).toBeUndefined();
    expect(res.end).toHaveBeenCalled();
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["cache-control"]).toBe("public, max-age=300, s-maxage=300");
  });

  test.each(["POST", "PUT", "PATCH", "DELETE"])("%s -> 405, zero spec leaked", async (method) => {
    const handler = loadHandler();
    const req = createMockReq({ method });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ ok: false, error: "method_not_allowed" });
    expect(res.headers["allow"]).toBe("GET, HEAD");
  });

  test("never leaks the forbidden emails anywhere in the full response body", async () => {
    const handler = loadHandler();
    const req = createMockReq({ method: "GET" });
    const res = createMockRes();
    await handler(req, res);

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("songshanshan1977@gmail.com");
    expect(serialized).not.toContain("songshanshan2025@gmail.com");
    expect(serialized).not.toContain("contact@okinawa-charter.com");
  });

  test("the FULL serialized API response does not contain the retired test brand name anywhere", async () => {
    const handler = loadHandler();
    const req = createMockReq({ method: "GET" });
    const res = createMockRes();
    await handler(req, res);

    const retiredTestBrandName = "Honest" + "Oki";
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(retiredTestBrandName);
    expect(serialized.toLowerCase()).not.toContain(retiredTestBrandName.toLowerCase());
  });

  test("the FULL serialized API response does not contain any real secret env-var name", async () => {
    const handler = loadHandler();
    const req = createMockReq({ method: "GET" });
    const res = createMockRes();
    await handler(req, res);

    const serialized = JSON.stringify(res.body);
    for (const name of ["AGENT_SERVICE_KEY", "AGENT_BOOKING_TOKEN_SECRET", "SUPABASE_SERVICE_ROLE_KEY", "STRIPE_SECRET_KEY", "RESEND_API_KEY"]) {
      expect(serialized).not.toContain(name);
    }
  });

  test("does not define a recommend_vehicle or other invented operationId", async () => {
    const handler = loadHandler();
    const req = createMockReq({ method: "GET" });
    const res = createMockRes();
    await handler(req, res);

    const allOperationIds = Object.values(res.body.paths)
      .flatMap((item) => [item.get, item.post])
      .filter(Boolean)
      .map((op) => op.operationId);
    expect(allOperationIds).not.toContain("recommend_vehicle");
  });

  test("zero real network requests occur (fetch is guarded globally by jest.setup.js)", async () => {
    const handler = loadHandler();
    const req = createMockReq({ method: "GET" });
    const res = createMockRes();
    await handler(req, res);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
