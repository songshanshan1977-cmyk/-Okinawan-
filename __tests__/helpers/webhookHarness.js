// __tests__/helpers/webhookHarness.js
//
// Loads a fresh copy of pages/api/stripe-webhook.js per test with 'stripe',
// '@supabase/supabase-js' and 'resend' replaced by controllable fakes —
// using jest.isolateModules + jest.doMock so each test gets an isolated
// module registry (module-level singletons like `const stripe = new
// Stripe(...)` are re-created from the fresh mocks every time, instead of
// leaking state between tests).

function loadWebhookHandler({ supabase, constructEvent, resendSend }) {
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
      Resend: jest.fn(function ResendMock() {
        return { emails: { send: resendSend || jest.fn(() => Promise.resolve({ id: "mock-email-id" })) } };
      }),
    }));

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
