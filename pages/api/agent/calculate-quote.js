// pages/api/agent/calculate-quote.js
//
// Agent tool endpoint: calculate_quote. Service-auth only. Never accepts a
// price from the caller — the only output price comes from calcTotalPrice's
// real get_car_price RPC call, via lib/agent/tools/calculateQuote.js.

import { verifyAgentService } from "../../../lib/agent/auth/verifyAgentService";
import { getSupabaseClient } from "../../../lib/agent/supabaseClient";
import { calculateQuoteTool } from "../../../lib/agent/tools/calculateQuote";
import { logAgentToolCall } from "../../../lib/agent/audit";
import { AGENT_ERROR_CODES, statusForCode } from "../../../lib/agent/errorCodes";

const TOOL_NAME = "calculate_quote";

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

    const result = await calculateQuoteTool({
      supabase,
      start_date: body.start_date,
      end_date: body.end_date,
      car_model_id: body.car_model_id,
      driver_lang: body.driver_lang,
      duration: body.duration,
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
