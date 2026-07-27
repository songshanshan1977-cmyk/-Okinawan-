// lib/agent/tools/checkAvailability.js
//
// Agent tool: check_availability. Thin wrapper around the shared
// lib/inventory/checkAvailability.js that PR #1 already built and froze —
// this file does NOT reimplement availability logic, and does not call any
// HTTP endpoint (pages/api/check-inventory.js) to reuse it; it calls the
// shared function directly, in-process, per the "must reuse, not copy or
// re-call over HTTP" instruction.
//
// checkAvailability()'s own success shape already IS the required output
// whitelist ({ok, available, unavailable_dates, min_remaining, checked}) —
// no additional field stripping is needed on the success path. Only the
// error path is remapped onto the shared AGENT_ERROR_CODES enum so every
// Agent tool endpoint reports failures the same way.
//
// A1-B03: lib/agent/validation/validateAvailabilityInput runs FIRST, before
// checkAvailability() ever touches supabase. This closes two real gaps
// checkAvailability()'s own (looser) checks leave open: it never validates
// car_model_id against the 3 real vehicle UUIDs, and its date check
// (`parseYMD` + local-time `Date`) does not reject a fake calendar date
// like 2026-02-30 — Date silently normalizes it to 2026-03-02 rather than
// rejecting it. The shared validator's isRealYMD() catches that before any
// query runs.

const { checkAvailability } = require("../../inventory/checkAvailability");
const { validateAvailabilityInput } = require("../validation/validateBookingInput");
const { AGENT_ERROR_CODES } = require("../errorCodes");

/**
 * @param {object} params
 * @param {object} params.supabase
 * @param {string} params.start_date
 * @param {string} params.end_date
 * @param {string} params.car_model_id
 * @param {string} params.driver_lang - exactly "zh"/"jp"/"ZH"/"JP"; anything else (including missing, or other casings/aliases like "ja") is rejected, never silently defaulted
 * @returns {Promise<{ok:true, available:boolean, unavailable_dates:object[], min_remaining:number, checked:object} | {ok:false, code:string}>}
 */
async function checkAvailabilityTool({ supabase, start_date, end_date, car_model_id, driver_lang }) {
  const validation = validateAvailabilityInput({ start_date, end_date, car_model_id, driver_lang });
  if (!validation.ok) {
    return validation;
  }

  const result = await checkAvailability({ supabase, start_date, end_date, car_model_id, driver_lang });

  if (!result.ok) {
    // lib/inventory/checkAvailability.js's own errors ("invalid_request" /
    // "inventory_check_failed") already match the Agent error-code enum
    // 1:1 by design (same overall system, same vocabulary) — passed
    // through verbatim rather than remapped.
    const code =
      result.error === "inventory_check_failed"
        ? AGENT_ERROR_CODES.INVENTORY_CHECK_FAILED
        : AGENT_ERROR_CODES.INVALID_REQUEST;
    return { ok: false, code };
  }

  return {
    ok: true,
    available: result.available,
    unavailable_dates: result.unavailable_dates,
    min_remaining: result.min_remaining,
    checked: result.checked,
  };
}

module.exports = { checkAvailabilityTool };
