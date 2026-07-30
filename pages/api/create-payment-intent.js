// pages/api/create-payment-intent.js
//
// A3: no longer trusts "knowing an orderId" as sufficient to create a
// Stripe Checkout Session. The caller must also hold the short-lived,
// one-time payment_token pages/api/create-order.js issued for this exact
// order (lib/payment/paymentAuthorization.js). Both the availability
// re-check and the Stripe session creation now live in the ONE shared
// lib/payment/createCheckoutSession.js function that
// lib/agent/tools/createPaymentLink.js also calls — this file no longer
// duplicates that logic.
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
const { createCheckoutSession } = require("../../lib/payment/createCheckoutSession");
const { AGENT_ERROR_CODES, statusForCode } = require("../../lib/agent/errorCodes");

// --------------------
// CORS
// --------------------
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// --------------------
// Env
// --------------------
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

const supabase = createClient(supabaseUrl, serviceRoleKey);
const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2022-11-15",
});

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { orderId, payment_token } = req.body || {};

    // 只有 orderId、没有 payment_token：直接 400，Stripe/RPC 0 调用。
    if (!orderId || !payment_token) {
      return res.status(400).json({ error: AGENT_ERROR_CODES.INVALID_REQUEST });
    }

    const result = await createCheckoutSession({ supabase, stripe, order_id: orderId, payment_token });

    if (!result.ok) {
      const status = statusForCode(result.code);
      const payload = { error: result.code };
      if (result.code === AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE) {
        payload.unavailable_dates = result.unavailable_dates;
      }
      return res.status(status).json(payload);
    }

    return res.status(200).json({
      url: result.url,
      stripe_session_id: result.stripe_session_id,
      order_id: result.order_id,
    });
  } catch (err) {
    console.error("🔥 create-payment-intent error:", err);
    return res.status(500).json({ error: "Payment intent failed" });
  }
}
