// pages/api/agent/create-booking-draft.js
//
// Agent tool endpoint: create_booking_draft. Service-auth only (issuing a
// booking_access_token IS the authorization hand-off for subsequent
// get-booking-summary calls — there is no pre-existing per-order token to
// check on the way in). Never trusts total_price / deposit_amount /
// payment_status / inventory_status / stripe_session_id from the request
// body even if present — lib/agent/tools/createBookingDraft.js structurally
// never reads those fields off `data`.

import { verifyAgentService } from "../../../lib/agent/auth/verifyAgentService";
import { getSupabaseClient } from "../../../lib/agent/supabaseClient";
import { createBookingDraftTool } from "../../../lib/agent/tools/createBookingDraft";
import { logAgentToolCall } from "../../../lib/agent/audit";
import { AGENT_ERROR_CODES, statusForCode } from "../../../lib/agent/errorCodes";

const TOOL_NAME = "create_booking_draft";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const auth = verifyAgentService(req);
  if (!auth.ok) {
    logAgentToolCall({ tool_name: TOOL_NAME, outcome: "failure", error_code: auth.code });
    return res.status(statusForCode(auth.code)).json({ ok: false, error: auth.code });
  }

  try {
    const body = req.body || {};
    const supabase = getSupabaseClient();

    const result = await createBookingDraftTool({ supabase, data: body });

    if (!result.ok) {
      logAgentToolCall({ tool_name: TOOL_NAME, order_id: body.existing_order_id, outcome: "failure", error_code: result.code });
      return res.status(statusForCode(result.code)).json({ ok: false, error: result.code });
    }

    logAgentToolCall({ tool_name: TOOL_NAME, order_id: result.order_id, outcome: "success" });
    return res.status(200).json(result);
  } catch (e) {
    logAgentToolCall({ tool_name: TOOL_NAME, outcome: "failure", error_code: AGENT_ERROR_CODES.INTERNAL_ERROR });
    return res.status(500).json({ ok: false, error: AGENT_ERROR_CODES.INTERNAL_ERROR });
  }
}
