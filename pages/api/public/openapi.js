// pages/api/public/openapi.js
//
// GET /api/public/openapi — the single public, unauthenticated, read-only
// HTTP entry point for lib/public/openapiSpec.js. Mirrors
// pages/api/public/service-facts.js's exact pattern: GET/HEAD only, no
// auth, no database/Stripe/Supabase/Resend call, no Secret ever read.

const { openapiSpec } = require("../../../lib/public/openapiSpec");

const CACHE_CONTROL = "public, max-age=300, s-maxage=300";

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

  return res.status(200).json(openapiSpec);
}
