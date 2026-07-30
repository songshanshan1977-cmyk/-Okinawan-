// lib/payment/stripeClient.js
//
// Single construction point for the Stripe client used by
// pages/api/agent/create-payment-link.js, mirroring
// lib/agent/supabaseClient.js's lazy-singleton pattern: constructed on first
// use (not at module load time) so Jest tests can mock the 'stripe' module
// before this file ever captures a real client reference.

const Stripe = require("stripe");

let cached = null;

function getStripeClient() {
  if (cached) return cached;
  cached = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2022-11-15" });
  return cached;
}

module.exports = { getStripeClient };
