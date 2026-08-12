const { createMockReq, createMockRes } = require("../helpers/mockReqRes");

function loadHandler() {
  const mod = require("../../pages/api/public/service-facts");
  return mod.default || mod;
}

describe("GET /api/public/service-facts", () => {
  test("GET succeeds, no Agent auth required, returns the full facts payload", async () => {
    const handler = loadHandler();
    // Deliberately NO Authorization header, NO X-Booking-Access-Token —
    // this endpoint must work without either.
    const req = createMockReq({ method: "GET" });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.schema).toBe("huaren-okinawa-service-facts");
    expect(res.body.version).toBe("2026-07-31-v1");
    expect(res.body.last_updated).toBe("2026-07-31");
    expect(res.body.facts.brand.name).toBe("华人Okinawa");
    expect(res.body.facts.reference_prices.matrix.economy_sedan.zh[8]).toBe(1600);
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
    // CORS/Cache-Control headers are still present on HEAD.
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["cache-control"]).toBe("public, max-age=300, s-maxage=300");
  });

  test.each(["POST", "PUT", "PATCH", "DELETE"])("%s -> 405, zero facts leaked", async (method) => {
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

    // Built from parts so this test file's own source never contains the
    // literal banned string either.
    const retiredTestBrandName = "Honest" + "Oki";
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(retiredTestBrandName);
    expect(serialized.toLowerCase()).not.toContain(retiredTestBrandName.toLowerCase());
  });

  test("brand has no legacy_names or aliases field, and the name is strictly 华人Okinawa", async () => {
    const handler = loadHandler();
    const req = createMockReq({ method: "GET" });
    const res = createMockRes();
    await handler(req, res);

    expect(res.body.facts.brand).not.toHaveProperty("legacy_names");
    expect(res.body.facts.brand).not.toHaveProperty("aliases");
    expect(res.body.facts.brand.name).toBe("华人Okinawa");
  });

  test("zero real network requests occur (fetch is guarded globally by jest.setup.js)", async () => {
    const handler = loadHandler();
    const req = createMockReq({ method: "GET" });
    const res = createMockRes();
    await handler(req, res);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
