// playwright.config.js
//
// Sandbox isolation: the dev server it boots is given obviously-fake,
// non-functional placeholder credentials (never real Stripe/Supabase
// values) purely so module-scope `createClient()`/`new Stripe()` calls
// don't throw on startup. No test is allowed to let a request actually
// reach those handlers over the network — see e2e/helpers/apiMock.js,
// which intercepts every request and either fulfills it with a mock or
// aborts it if it isn't localhost.

const PORT = 3100;

/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: "./e2e",
  timeout: 30000,
  fullyParallel: false,
  workers: 1, // 单个 dev server 实例，串行跑更稳定，避免并发资源争抢导致的偶发超时
  retries: 0,
  reporter: [["list"]],
  outputDir: "./e2e-results", // screenshots/traces — see .gitignore
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- -p " + PORT,
    port: PORT,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      // 明显虚构的占位值，仅用于防止模块加载时的构造函数报错；
      // 沙盒里没有任何一条测试会真正放行请求打到这些凭证背后的服务。
      NEXT_PUBLIC_SUPABASE_URL: "https://sandbox.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "sandbox-mock-key-not-real",
      STRIPE_SECRET_KEY: "sandbox-mock-key-not-real",
      NEXT_PUBLIC_SITE_URL: `http://localhost:${PORT}`,
    },
  },
};
