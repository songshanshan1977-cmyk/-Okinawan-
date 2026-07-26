// pages/api/agent/check-availability.js
//
// Agent tool endpoint: check_availability. Service-auth only (no
// booking_access_token — availability isn't scoped to any one order).

import { verifyAgentService } from "../../../lib/agent/auth/verifyAgentService";
import { getSupabaseClient } from "../../../lib/agent/supabaseClient";
import { checkAvailabilityTool } from "../../../lib/agent/tools/checkAvailability";
import { logAgentToolCall } from "../../../lib/agent/audit";
import { AGENT_ERROR_CODES, statusForCode } from "../../../lib/agent/errorCodes";

const TOOL_NAME = "check_availability";

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

    const result = await checkAvailabilityTool({
      supabase,
      start_date: body.start_date,
      end_date: body.end_date,
      car_model_id: body.car_model_id,
      driver_lang: body.driver_lang,
    });

    if (!result.ok) {
      logAgentToolCall({ tool_name: TOOL_NAME, outcome: "failure", error_code: result.code });
      return res.status(statusForCode(result.code)).json({ ok: false, error: result.code });
    }

    logAgentToolCall({ tool_name: TOOL_NAME, outcome: "success" });
    return res.status(200).json(result);
  } catch (e) {
    logAgentToolCall({ tool_name: TOOL_NAME, outcome: "failure", error_code: AGENT_ERROR_CODES.INTERNAL_ERROR });
    return res.status(500).json({ ok: false, error: AGENT_ERROR_CODES.INTERNAL_ERROR });
  }
}
