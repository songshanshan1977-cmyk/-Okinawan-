// pages/api/public/agent-capabilities.js
//
// GET /api/public/agent-capabilities — the single public, unauthenticated,
// read-only HTTP entry point for lib/public/agentCapabilities.js. Mirrors
// pages/api/public/service-facts.js's exact pattern: GET/HEAD only, no
// auth, no database/Stripe/Supabase/Resend call, no Secret ever read.

const { AGENT_CAPABILITIES_VERSION, agentCapabilities } = require("../../../lib/public/agentCapabilities");
const { SERVICE_FACTS_VERSION } = require("../../../lib/public/serviceFacts");

const SCHEMA_NAME = "huaren-okinawa-agent-capabilities";
const CACHE_CONTROL = "public, max-age=300, s-maxage=300";

function buildPayload() {
  return {
    ok: true,
    schema: SCHEMA_NAME,
    version: AGENT_CAPABILITIES_VERSION,
    service_facts_version: SERVICE_FACTS_VERSION,
    capabilities: agentCapabilities,
  };
}

function setCommonHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", CACHE_CONTROL);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
}

export default function handler(req, res) {
  setCommonHeaders(res);

  if (req.method === "HEAD") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  return res.status(200).json(buildPayload());
}
