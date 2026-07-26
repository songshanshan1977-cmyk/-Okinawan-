// lib/agent/supabaseClient.js
//
// Single construction point for the Supabase client used by every
// pages/api/agent/*.js handler, mirroring the existing pattern used
// site-wide (pages/api/create-order.js, pages/api/check-inventory.js,
// etc. each call createClient(...) once at module scope). Kept as its own
// tiny module — rather than duplicated in four new handler files — purely
// to avoid four copies of the same two-line construction; it changes
// nothing about how the client behaves or is wired.
//
// Lazily constructed (not at module load time) so Jest tests can mock
// '@supabase/supabase-js' via jest.doMock + jest.isolateModules the same
// way __tests__/api/create-order.test.js already does, without this module
// having captured a real client reference before the mock was installed.

const { createClient } = require("@supabase/supabase-js");

let cached = null;

function getSupabaseClient() {
  if (cached) return cached;
  cached = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return cached;
}

module.exports = { getSupabaseClient };
