// pages/api/agent/create-payment-link.js
//
// Agent tool endpoint: create_payment_link (A3). Same two-layer auth
// pattern as every other pages/api/agent/*.js endpoint:
//   1. service-level: Authorization: Bearer <AGENT_SERVICE_KEY>
//   2. order-level:   X-Booking-Access-Token: <booking_access_token>
//
// order_id comes from the POST body, the booking_access_token from a
// dedicated header — never a query string.

import { verifyAgentService } from "../../../lib/agent/auth/verifyAgentService";
import { verifyBookingAccessToken } from "../../../lib/agent/tokens/bookingAccessToken";
import { getSupabaseClient } from "../../../lib/agent/supabaseClient";
import { getStripeClient } from "../../../lib/payment/stripeClient";
import { createPaymentLinkTool } from "../../../lib/agent/tools/createPaymentLink";
import { logAgentToolCall } from "../../../lib/agent/audit";
import { AGENT_ERROR_CODES, statusForCode } from "../../../lib/agent/errorCodes";

const TOOL_NAME = "create_payment_link";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const auth = verifyAgentService(req);
  if (!auth.ok) {
    logAgentToolCall({ tool_name: TOOL_NAME, outcome: "failure", error_code: auth.code });
    return res.status(statusForCode(auth.code)).json({ ok: false, error: auth.code });
  }

  const body = req.body || {};
  const order_id = body.order_id;
  const bookingToken = req.headers["x-booking-access-token"];

  if (!order_id) {
    logAgentToolCall({ tool_name: TOOL_NAME, outcome: "failure", error_code: AGENT_ERROR_CODES.INVALID_REQUEST });
    return res.status(statusForCode(AGENT_ERROR_CODES.INVALID_REQUEST)).json({ ok: false, error: AGENT_ERROR_CODES.INVALID_REQUEST });
  }

  const tokenCheck = verifyBookingAccessToken({ token: bookingToken, order_id });
  if (!tokenCheck.ok) {
    logAgentToolCall({ tool_name: TOOL_NAME, order_id, outcome: "failure", error_code: tokenCheck.code });
    return res.status(statusForCode(tokenCheck.code)).json({ ok: false, error: tokenCheck.code });
  }

  try {
    const supabase = getSupabaseClient();
    const stripe = getStripeClient();
    const result = await createPaymentLinkTool({ supabase, stripe, order_id });

    if (!result.ok) {
      logAgentToolCall({ tool_name: TOOL_NAME, order_id, outcome: "failure", error_code: result.code });
      const payload = { ok: false, error: result.code };
      if (result.code === AGENT_ERROR_CODES.INVENTORY_UNAVAILABLE) {
        payload.unavailable_dates = result.unavailable_dates;
      }
      return res.status(statusForCode(result.code)).json(payload);
    }

    logAgentToolCall({ tool_name: TOOL_NAME, order_id, outcome: "success" });
    return res.status(200).json(result);
  } catch (e) {
    logAgentToolCall({ tool_name: TOOL_NAME, order_id, outcome: "failure", error_code: AGENT_ERROR_CODES.INTERNAL_ERROR });
    return res.status(500).json({ ok: false, error: AGENT_ERROR_CODES.INTERNAL_ERROR });
  }
}
