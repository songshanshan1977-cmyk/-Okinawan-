// __tests__/helpers/webhookHarness.js
//
// Loads a fresh copy of pages/api/stripe-webhook.js per test with 'stripe',
// '@supabase/supabase-js' and 'resend' replaced by controllable fakes —
// using jest.isolateModules + jest.doMock so each test gets an isolated
// module registry (module-level singletons like `const stripe = new
// Stripe(...)` are re-created from the fresh mocks every time, instead of
// leaking state between tests).

function loadWebhookHandler({ supabase, constructEvent, resendSend, notificationContentOverride }) {
  let handlerModule;

  jest.isolateModules(() => {
    jest.doMock("@supabase/supabase-js", () => ({
      createClient: jest.fn(() => supabase),
    }));

    jest.doMock("stripe", () => {
      // Must be a real function (not an arrow fn) so `new Stripe(...)` is a
      // valid constructor call; returning an object from it overrides the
      // constructed `this`, which is exactly what we want here.
      return jest.fn(function StripeMock() {
        return { webhooks: { constructEvent } };
      });
    });

    jest.doMock("resend", () => ({
      // Resend 4.3.0's Resend class; .send(payload, {idempotencyKey}) is a
      // real two-argument call in production code — the mock just records
      // whatever args it's given, callers assert on resendSend.mock.calls.
      Resend: jest.fn(function ResendMock() {
        return { emails: { send: resendSend || jest.fn(() => Promise.resolve({ data: { id: "mock-email-id" }, error: null })) } };
      }),
    }));

    // Only used by tests that need to force a notification-content edge
    // case (e.g. an ops row with no resolvable recipient) that the real
    // notificationContent.js module can't naturally produce because
    // OPS_EMAIL_TO always falls back to a hardcoded address. jest.doMock's
    // registration is NOT automatically cleared by isolateModules alone —
    // without the explicit dontMock in the else branch, a prior test that
    // used an override would silently leak its fake module into every
    // later test in the same file.
    if (notificationContentOverride) {
      jest.doMock("../../lib/webhook/notificationContent", () => ({
        buildNotificationContent: notificationContentOverride,
        NOTIFICATION_TYPES: [],
      }));
    } else {
      jest.dontMock("../../lib/webhook/notificationContent");
    }

    handlerModule = require("../../pages/api/stripe-webhook");
  });

  return handlerModule.default;
}

function fakeCheckoutSessionCompletedEvent({
  id = "evt_test_1",
  sessionId = "cs_test_1",
  orderId = "ORD-20260722-11111",
  clientReferenceId,
  paymentStatus = "paid",
  amountTotal = 50000,
  currency = "cny",
} = {}) {
  return {
    id,
    type: "checkout.session.completed",
    livemode: false,
    data: {
      object: {
        id: sessionId,
        payment_status: paymentStatus,
        amount_total: amountTotal,
        currency,
        metadata: orderId ? { order_id: orderId } : {},
        client_reference_id: clientReferenceId,
      },
    },
  };
}

module.exports = { loadWebhookHandler, fakeCheckoutSessionCompletedEvent };
