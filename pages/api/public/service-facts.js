// pages/api/public/service-facts.js
//
// GET /api/public/service-facts — the single public, unauthenticated,
// read-only HTTP entry point for lib/public/serviceFacts.js. No Agent
// service key, no booking_access_token, no Supabase/Stripe/Resend call —
// this is deliberately the lowest-friction machine-readable fact source on
// the whole site, so future consumers (Cloudflare Worker, llms.txt/
// ai-summary generators, Agent capabilities/OpenAPI/Tool Schema) have one
// place to read from instead of each hardcoding their own copy.
//
// GET and HEAD only. Every other method is 405. Never touches a database,
// never calls an external service, never reads process.env for a secret —
// the response body is exactly, and only, the frozen serviceFacts object.

const {
  SERVICE_FACTS_VERSION,
  SERVICE_FACTS_LAST_UPDATED,
  serviceFacts,
} = require("../../../lib/public/serviceFacts");

const SCHEMA_NAME = "huaren-okinawa-service-facts";
const CACHE_CONTROL = "public, max-age=300, s-maxage=300";

function buildPayload() {
  return {
    ok: true,
    schema: SCHEMA_NAME,
    version: SERVICE_FACTS_VERSION,
    last_updated: SERVICE_FACTS_LAST_UPDATED,
    facts: serviceFacts,
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
