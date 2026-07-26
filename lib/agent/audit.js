// lib/agent/audit.js
//
// The ONLY place any pages/api/agent/*.js handler is allowed to write a log
// line. Deliberately exposes a single function with a closed, fixed
// parameter shape — {tool_name, order_id, outcome, error_code} — so there
// is no call-site-accessible way to accidentally log a token, a name/
// phone/email/wechat/remark/itinerary value, a raw request body, or a raw
// Supabase/Node error object. Nothing else in this branch should call
// console.* directly for anything Agent-tool-related.
//
// order_id is masked with the same irreversible-hash-not-truncation
// principle established elsewhere in this project's webhook logging work
// (SHA-256, not reversible, not a byte-for-byte copy of the original
// engagement's helper — that file lives on a different, unmerged branch —
// this is a fresh, self-contained implementation on this branch only).

const crypto = require("crypto");

function maskOrderId(orderId) {
  if (!orderId) return null;
  return "order#" + crypto.createHash("sha256").update(String(orderId), "utf8").digest("hex").slice(0, 12);
}

/**
 * @param {object} params
 * @param {string} params.tool_name
 * @param {string} [params.order_id] - raw order_id; masked before logging, never logged raw
 * @param {"success"|"failure"} params.outcome
 * @param {string} [params.error_code] - one of lib/agent/errorCodes.js's AGENT_ERROR_CODES values
 */
function logAgentToolCall({ tool_name, order_id, outcome, error_code }) {
  const line = {
    tool_name: tool_name || "unknown_tool",
    order_id: maskOrderId(order_id),
    outcome: outcome === "success" ? "success" : "failure",
    error_code: error_code || null,
    timestamp: new Date().toISOString(),
  };

  if (line.outcome === "success") {
    console.info("[agent-tools]", JSON.stringify(line));
  } else {
    console.warn("[agent-tools]", JSON.stringify(line));
  }
}

module.exports = { logAgentToolCall, maskOrderId };
