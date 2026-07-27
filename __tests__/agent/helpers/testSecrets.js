// __tests__/agent/helpers/testSecrets.js
//
// Shared fake-but-sufficiently-long secret fixtures for every Agent test
// file, now that lib/agent/config.js enforces a 32-byte minimum and
// rejects the two Agent secrets being equal. Centralized so every test
// file uses the same two DISTINCT, >=32-byte values rather than each
// re-inventing (and risking an accidental collision between) its own.
// Never real secrets — used only inside Jest, never written anywhere else.

const TEST_AGENT_SERVICE_KEY = "test-service-key-" + "a".repeat(20); // 38 bytes
const TEST_AGENT_BOOKING_TOKEN_SECRET = "test-hmac-secret-" + "b".repeat(20); // 38 bytes
const TEST_SHORT_SECRET = "too-short"; // deliberately < 32 bytes, for fail-close tests

module.exports = { TEST_AGENT_SERVICE_KEY, TEST_AGENT_BOOKING_TOKEN_SECRET, TEST_SHORT_SECRET };
