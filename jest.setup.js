// jest.setup.js
//
// Sandbox isolation guardrail: fail loudly if any test path attempts a real
// network call instead of using the required mocks. This is a backstop —
// individual tests are still responsible for jest.mock('stripe'),
// jest.mock('@supabase/supabase-js') and jest.mock('resend').

global.fetch = jest.fn(() => {
  throw new Error(
    "SANDBOX ISOLATION VIOLATION: a test attempted a real network call via fetch(). " +
      "Stripe, Supabase and Resend must be mocked in every test."
  );
});

// Defensive: make sure no test accidentally relies on real production
// credentials being present in the environment.
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.RESEND_API_KEY;
process.env.NEXT_PUBLIC_SITE_URL = "https://sandbox.invalid";
