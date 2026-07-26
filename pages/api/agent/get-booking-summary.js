// pages/api/agent/get-booking-summary.js
//
// Agent tool endpoint: get_booking_summary. Two auth layers:
//   1. service-level: Authorization: Bearer <AGENT_SERVICE_KEY>
//   2. order-level:   X-Booking-Access-Token: <booking_access_token>
//
// order_id is read from the POST body, and the booking_access_token from a
// dedicated request HEADER — deliberately NOT a query-string parameter for
// either. A query string is the one place most likely to be copied into
// server access logs, proxy logs, or browser history verbatim; keeping
// both the order_id and (especially) the token out of the URL avoids that
// exposure entirely. This is also why this endpoint is POST, not GET, even
// though it is a pure read — mirrors the same reasoning pages/api/get-order.js
// notably does NOT follow today (GET with order_id as a query param).
//
// This is the direct replacement for pages/api/get-order.js's
// `select('*')` for any Agent-facing read — get-order.js itself is
// untouched and still exists for the web frontend's own use.

import { verifyAgentService } from "../../../lib/agent/auth/verifyAgentService";
import { verifyBookingAccessToken } from "../../../lib/agent/tokens/bookingAccessToken";
import { getSupabaseClient } from "../../../lib/agent/supabaseClient";
import { getBookingSummaryTool } from "../../../lib/agent/tools/getBookingSummary";
import { logAgentToolCall } from "../../../lib/agent/audit";
import { AGENT_ERROR_CODES, statusForCode } from "../../../lib/agent/errorCodes";

const TOOL_NAME = "get_booking_summary";

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
    const result = await getBookingSummaryTool({ supabase, order_id });

    if (!result.ok) {
      logAgentToolCall({ tool_name: TOOL_NAME, order_id, outcome: "failure", error_code: result.code });
      return res.status(statusForCode(result.code)).json({ ok: false, error: result.code });
    }

    logAgentToolCall({ tool_name: TOOL_NAME, order_id, outcome: "success" });
    return res.status(200).json(result);
  } catch (e) {
    logAgentToolCall({ tool_name: TOOL_NAME, order_id, outcome: "failure", error_code: AGENT_ERROR_CODES.INTERNAL_ERROR });
    return res.status(500).json({ ok: false, error: AGENT_ERROR_CODES.INTERNAL_ERROR });
  }
}
