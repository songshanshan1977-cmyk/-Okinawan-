// tests/db-integration/timing.test.js
//
// Phase 1 POSTGRES CONTRACT FIXTURE tests for the 23-hour dead-letter sweep
// inside claim_webhook_notification_v1. All scenarios simulate elapsed time
// by directly UPDATE-ing first_dispatch_at into the past — no real sleeping.

const { hasDb, getPool, closePool, uniqueId, insertOrder, insertInventory } = require("./helpers/postgres");

const CLAIM = "claim_webhook_notification_v1";
const PAYMENT_RPC = "process_checkout_payment_v1";

const describeIfDb = hasDb() ? describe : describe.skip;

async function createOutboxPairViaPayment(client) {
  const cmId = await insertInventory(client, { dates: ["2029-01-01"] });
  const orderId = await insertOrder(client, { car_model_id: cmId, start_date: "2029-01-01", end_date: "2029-01-01", deposit_amount: 500 });
  const sessionId = uniqueId("cs_test");
  const { rows } = await client.query(`SELECT public.${PAYMENT_RPC}($1,$2,$3,$4,$5) AS r`, [orderId, sessionId, 50000, "cny", false]);
  expect(rows[0].r.result).toBe("locked");
  return { orderId, sessionId };
}

describeIfDb("timing boundaries (C)", () => {
  let pool;
  beforeAll(() => {
    pool = getPool();
  });
  afterAll(async () => {
    await closePool();
  });

  test("1. first_dispatch_at 22h59m ago -> still claimable, not dead_letter", async () => {
    const client = await pool.connect();
    try {
      const { orderId, sessionId } = await createOutboxPairViaPayment(client);
      const first = await client.query(`SELECT * FROM public.${CLAIM}($1,$2)`, [orderId, sessionId]);
      const row = first.rows[0];

      // Roll first_dispatch_at back 22h59m and make it re-claimable (as if
      // the lease had also expired).
      await client.query(
        `UPDATE public.send_logs
         SET first_dispatch_at = now() - interval '22 hours 59 minutes',
             status = 'failed', claim_token = NULL, claim_expires_at = NULL
         WHERE dedupe_key = $1`,
        [row.dedupe_key]
      );

      const second = await client.query(`SELECT * FROM public.${CLAIM}($1,$2)`, [orderId, sessionId]);
      const reclaimed = second.rows.find((r) => r.dedupe_key === row.dedupe_key);
      expect(reclaimed).toBeDefined();

      const status = await client.query(`SELECT status FROM public.send_logs WHERE dedupe_key = $1`, [row.dedupe_key]);
      expect(status.rows[0].status).toBe("processing");
    } finally {
      client.release();
    }
  });

  test("2. first_dispatch_at exactly 23h ago -> swept to dead_letter, not claimable", async () => {
    const client = await pool.connect();
    try {
      const { orderId, sessionId } = await createOutboxPairViaPayment(client);
      const first = await client.query(`SELECT * FROM public.${CLAIM}($1,$2)`, [orderId, sessionId]);
      const row = first.rows[0];

      await client.query(
        `UPDATE public.send_logs
         SET first_dispatch_at = now() - interval '23 hours',
             status = 'failed', claim_token = NULL, claim_expires_at = NULL
         WHERE dedupe_key = $1`,
        [row.dedupe_key]
      );

      const second = await client.query(`SELECT * FROM public.${CLAIM}($1,$2)`, [orderId, sessionId]);
      const reclaimed = second.rows.find((r) => r.dedupe_key === row.dedupe_key);
      expect(reclaimed).toBeUndefined();

      const status = await client.query(`SELECT status, error_message FROM public.send_logs WHERE dedupe_key = $1`, [row.dedupe_key]);
      expect(status.rows[0].status).toBe("dead_letter");
      expect(status.rows[0].error_message).toBe("provider_delivery_uncertain");
    } finally {
      client.release();
    }
  });

  test("3. first_dispatch_at IS NULL (never actually dispatched yet) -> never swept, regardless of created_at age", async () => {
    const client = await pool.connect();
    try {
      const { orderId, sessionId } = await createOutboxPairViaPayment(client);
      const dk = `${orderId}:${sessionId}:customer:customer_booking_confirmed`;

      // Sanity: first_dispatch_at is NULL until the row's first claim.
      const before = await client.query(`SELECT first_dispatch_at FROM public.send_logs WHERE dedupe_key = $1`, [dk]);
      expect(before.rows[0].first_dispatch_at).toBeNull();

      // Calling claim (which runs the sweep first) must not dead-letter it —
      // the sweep's WHERE clause explicitly requires first_dispatch_at IS NOT NULL.
      const claimed = await client.query(`SELECT * FROM public.${CLAIM}($1,$2)`, [orderId, sessionId]);
      const row = claimed.rows.find((r) => r.dedupe_key === dk);
      expect(row).toBeDefined();

      const status = await client.query(`SELECT status FROM public.send_logs WHERE dedupe_key = $1`, [dk]);
      expect(status.rows[0].status).toBe("processing");
    } finally {
      client.release();
    }
  });

  test("4. an already-'sent' row is unaffected by the sweep even with an old first_dispatch_at", async () => {
    const client = await pool.connect();
    try {
      const { orderId, sessionId } = await createOutboxPairViaPayment(client);
      const first = await client.query(`SELECT * FROM public.${CLAIM}($1,$2)`, [orderId, sessionId]);
      const row = first.rows[0];

      await client.query(`SELECT public.freeze_webhook_notification_payload_v1($1,$2,$3,$4,$5,$6,$7)`, [
        row.dedupe_key, row.claim_token, "s@example.com", "r@example.com", "subj", "<p>h</p>", "webhook-timing-test-key",
      ]);
      await client.query(`SELECT public.complete_webhook_notification_v1($1,$2,$3,$4,$5)`, [row.dedupe_key, row.claim_token, "sent", "provider-msg-1", null]);

      await client.query(`UPDATE public.send_logs SET first_dispatch_at = now() - interval '30 hours' WHERE dedupe_key = $1`, [row.dedupe_key]);

      // Trigger the sweep again via another claim call for this order/session.
      await client.query(`SELECT * FROM public.${CLAIM}($1,$2)`, [orderId, sessionId]);

      const status = await client.query(`SELECT status FROM public.send_logs WHERE dedupe_key = $1`, [row.dedupe_key]);
      expect(status.rows[0].status).toBe("sent");
    } finally {
      client.release();
    }
  });

  test("5. a dead_letter row is never claimed again, even long after", async () => {
    const client = await pool.connect();
    try {
      const { orderId, sessionId } = await createOutboxPairViaPayment(client);
      const first = await client.query(`SELECT * FROM public.${CLAIM}($1,$2)`, [orderId, sessionId]);
      const row = first.rows[0];

      await client.query(`SELECT public.complete_webhook_notification_v1($1,$2,$3,$4,$5)`, [row.dedupe_key, row.claim_token, "dead_letter", null, "test_deterministic_failure"]);

      const later = await client.query(`SELECT * FROM public.${CLAIM}($1,$2)`, [orderId, sessionId]);
      const reclaimed = later.rows.find((r) => r.dedupe_key === row.dedupe_key);
      expect(reclaimed).toBeUndefined();

      const status = await client.query(`SELECT status FROM public.send_logs WHERE dedupe_key = $1`, [row.dedupe_key]);
      expect(status.rows[0].status).toBe("dead_letter");
    } finally {
      client.release();
    }
  });
});
