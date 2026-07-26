// e2e/helpers/apiMock.js
//
// Single network gatekeeper for every Playwright test in this sandbox:
//   - localhost/127.0.0.1 requests to one of the 5 booking API endpoints
//     are fulfilled by a per-test responder function — they NEVER reach
//     the real Next.js API route handler, so no real Supabase/Stripe call
//     is even possible.
//   - localhost requests to anything else (pages, JS chunks, HMR, Next
//     internals) pass through untouched, so the app renders normally.
//   - ANY non-localhost request is aborted and logged as a violation.
//     Tests assert externalRequests.length === 0.

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1"]);

const ENDPOINT_MAP = {
  "/api/get-car-price": "getCarPrice",
  "/api/check-inventory": "checkInventory",
  "/api/create-order": "createOrder",
  "/api/create-payment-intent": "createPaymentIntent",
  "/api/get-order": "getOrder",
};

function createApiMock() {
  const calls = {
    getCarPrice: [],
    checkInventory: [],
    createOrder: [],
    createPaymentIntent: [],
    getOrder: [],
  };
  const responders = {
    getCarPrice: null,
    checkInventory: null,
    createOrder: null,
    createPaymentIntent: null,
    getOrder: null,
  };
  const externalRequests = [];

  function setResponder(name, fn) {
    if (!(name in responders)) {
      throw new Error(`apiMock: unknown endpoint key "${name}"`);
    }
    responders[name] = fn;
  }

  async function install(page) {
    await page.route("**/*", async (route) => {
      const req = route.request();
      let url;
      try {
        url = new URL(req.url());
      } catch (e) {
        return route.abort();
      }

      if (!ALLOWED_HOSTS.has(url.hostname)) {
        externalRequests.push(req.url());
        return route.abort();
      }

      const key = ENDPOINT_MAP[url.pathname];
      if (!key) {
        return route.continue(); // 页面本身 / JS chunk / HMR 等，正常放行
      }

      let bodyJson = null;
      try {
        bodyJson = req.postDataJSON();
      } catch (e) {
        // GET 请求（如 get-car-price / get-order 用 query string）没有 JSON body
      }
      const query = Object.fromEntries(url.searchParams.entries());

      calls[key].push({ url: req.url(), method: req.method(), body: bodyJson, query });

      const responderFn = responders[key];
      if (!responderFn) {
        // 明确失败，而不是放行到真实 handler（真实 handler 会用假凭证连 Supabase/Stripe 失败或产生未定义行为）
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: `apiMock: no responder registered for ${key}` }),
        });
      }

      const response = await responderFn({ body: bodyJson, query, callIndex: calls[key].length - 1 });
      return route.fulfill({
        status: response.status ?? 200,
        contentType: "application/json",
        body: JSON.stringify(response.body ?? {}),
      });
    });
  }

  return { install, setResponder, calls, externalRequests };
}

// 明确禁止的域名——沙盒里这几个必须是 0 命中。其他被拦截的外部请求（例如
// GA4 的 googletagmanager.com 分析脚本）不属于 Stripe/Supabase/Vercel/生产
// 域名违规，但依然会被 install() 无条件 abort，只是不计入这份硬性清单。
const FORBIDDEN_DOMAIN_PATTERNS = [/stripe\.com$/i, /supabase\.co$/i, /vercel\.app$/i, /xn--okinawa-n14kh45a\.com$/i];

function assertNoForbiddenExternalRequests(mock) {
  const hits = mock.externalRequests.filter((url) => FORBIDDEN_DOMAIN_PATTERNS.some((p) => p.test(new URL(url).hostname)));
  if (hits.length > 0) {
    throw new Error(`Forbidden external request(s) detected: ${JSON.stringify(hits)}`);
  }
}

module.exports = { createApiMock, FORBIDDEN_DOMAIN_PATTERNS, assertNoForbiddenExternalRequests };
