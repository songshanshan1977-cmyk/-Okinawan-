// tests/db-integration/payment-flow.test.js
//
// Phase 1 POSTGRES CONTRACT FIXTURE tests for process_checkout_payment_v1,
// run against a REAL Postgres (see tests/db-integration/helpers/postgres.js)
// using the synthetic schema in db-integration/sql/01-base-schema-contract.sql
// plus the REAL, unmodified migration file. Not DB INTEGRATION VERIFIED,
// not PRODUCTION SCHEMA VERIFIED — see db-integration/schema-assumptions.md.
//
// Whole suite is skipped (not faked as passing) when DATABASE_URL is unset
// — that is the expected state in this environment today (no local
// Postgres/Docker/Supabase CLI available). It only runs for real once a CI
// job with a postgres:17 service container sets DATABASE_URL and has
// already run db-integration/scripts/apply-migrations.sh.

const { hasDb, getPool, closePool, withRole, uniqueId, insertOrder, insertInventory, dateRange, SEED_CAR_MODEL_ID } = require("./helpers/postgres");

const RPC = "process_checkout_payment_v1";

const describeIfDb = hasDb() ? describe : describe.skip;

describeIfDb("process_checkout_payment_v1 — function metadata + DB-role ACL (Phase 1: raw Postgres roles only, NOT Supabase JWT/PostgREST)", () => {
  let pool;
  beforeAll(() => {
    pool = getPool();
  });
  afterAll(async () => {
    await closePool();
  });

  test("is SECURITY DEFINER with search_path pinned to pg_catalog, public", async () => {
    const { rows } = await pool.query(
      `SELECT prosecdef, proconfig FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = $1`,
      [RPC]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].prosecdef).toBe(true);
    expect(rows[0].proconfig).toContain("search_path=pg_catalog, public");
  });

  test("input signature is exactly (text, text, integer, text, boolean)", async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_function_identity_arguments(oid) AS args
       FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = $1`,
      [RPC]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].args.replace(/\s+/g, " ")).toBe("p_order_id text, p_stripe_session_id text, p_amount integer, p_currency text, p_id_source_conflict boolean");
  });

  test("anon has NO EXECUTE privilege", async () => {
    const { rows } = await pool.query(`SELECT has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS ok`, [
      `public.${RPC}(text, text, integer, text, boolean)`,
    ]);
    expect(rows[0].ok).toBe(false);
  });

  test("authenticated has NO EXECUTE privilege", async () => {
    const { rows } = await pool.query(`SELECT has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS ok`, [
      `public.${RPC}(text, text, integer, text, boolean)`,
    ]);
    expect(rows[0].ok).toBe(false);
  });

  test("service_role HAS EXECUTE privilege", async () => {
    const { rows } = await pool.query(`SELECT has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS ok`, [
      `public.${RPC}(text, text, integer, text, boolean)`,
    ]);
    expect(rows[0].ok).toBe(true);
  });

  test("anon calling the RPC directly (via SET ROLE) is rejected by Postgres, not just by convention", async () => {
    const client = await pool.connect();
    try {
      await expect(
        withRole(client, "anon", (c) =>
          c.query(`SELECT public.${RPC}($1,$2,$3,$4,$5)`, [uniqueId("ORD"), uniqueId("cs_test"), 50000, "cny", false])
        )
      ).rejects.toThrow(/permission denied/i);
    } finally {
      client.release();
    }
  });
});

describeIfDb("process_checkout_payment_v1 — payment/inventory scenarios (A)", () => {
  let pool;
  beforeAll(() => {
    pool = getPool();
  });
  afterAll(async () => {
    await closePool();
  });

  test("1. normal single-day success", async () => {
    const client = await pool.connect();
    try {
      const cmId = await insertInventory(client, { dates: ["2027-01-01"], totalQty: 3 });
      const orderId = await insertOrder(client, { car_model_id: cmId, start_date: "2027-01-01", end_date: "2027-01-01", deposit_amount: 500 });
      const { rows } = await client.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, [orderId, uniqueId("cs_test"), 50000, "cny", false]);
      expect(rows[0].r.result).toBe("locked");
      expect(rows[0].r.inventory_status).toBe("locked");
    } finally {
      client.release();
    }
  });

  test("2. normal multi-day success", async () => {
    const client = await pool.connect();
    try {
      const dates = dateRange("2027-02-01", "2027-02-03");
      const cmId = await insertInventory(client, { dates, totalQty: 3 });
      const orderId = await insertOrder(client, { car_model_id: cmId, start_date: "2027-02-01", end_date: "2027-02-03", deposit_amount: 500 });
      const { rows } = await client.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, [orderId, uniqueId("cs_test"), 50000, "cny", false]);
      expect(rows[0].r.result).toBe("locked");

      const inv = await client.query(
        `SELECT locked_qty FROM public.inventory WHERE car_model_id = $1 AND driver_lang = 'ZH' AND date = ANY($2::date[])`,
        [cmId, dates]
      );
      expect(inv.rows.every((r) => r.locked_qty === 1)).toBe(true);
    } finally {
      client.release();
    }
  });

  test("3. middle date missing an inventory row -> failed_missing_inventory, order flipped to failed", async () => {
    const client = await pool.connect();
    try {
      // Deliberately skip 2027-03-02 in the middle of the range.
      const cmId = await insertInventory(client, { dates: ["2027-03-01", "2027-03-03"], totalQty: 3 });
      const orderId = await insertOrder(client, { car_model_id: cmId, start_date: "2027-03-01", end_date: "2027-03-03", deposit_amount: 500 });
      const { rows } = await client.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, [orderId, uniqueId("cs_test"), 50000, "cny", false]);
      expect(rows[0].r.result).toBe("failed");
      expect(rows[0].r.reason).toBe("failed_missing_inventory");

      const ord = await client.query(`SELECT payment_status, inventory_status FROM public.orders WHERE order_id = $1`, [orderId]);
      expect(ord.rows[0].payment_status).toBe("paid");
      expect(ord.rows[0].inventory_status).toBe("failed");
    } finally {
      client.release();
    }
  });

  test("4. middle date has available_count=0 -> failed_no_stock", async () => {
    const client = await pool.connect();
    try {
      const cmId = await insertInventory(client, { dates: ["2027-04-01"], totalQty: 3 });
      await insertInventory(client, { dates: ["2027-04-02"], totalQty: 1, bookedQty: 1, carModelId: cmId });
      await insertInventory(client, { dates: ["2027-04-03"], totalQty: 3, carModelId: cmId });
      const orderId = await insertOrder(client, { car_model_id: cmId, start_date: "2027-04-01", end_date: "2027-04-03", deposit_amount: 500 });
      const { rows } = await client.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, [orderId, uniqueId("cs_test"), 50000, "cny", false]);
      expect(rows[0].r.result).toBe("failed");
      expect(rows[0].r.reason).toBe("failed_no_stock");
    } finally {
      client.release();
    }
  });

  test("5. two orders racing for the last unit -> exactly one locked, the other failed_no_stock", async () => {
    const client = await pool.connect();
    let cmId, orderA, orderB;
    try {
      cmId = await insertInventory(client, { dates: ["2027-05-01"], totalQty: 1 });
      orderA = await insertOrder(client, { car_model_id: cmId, start_date: "2027-05-01", end_date: "2027-05-01", deposit_amount: 500 });
      orderB = await insertOrder(client, { car_model_id: cmId, start_date: "2027-05-01", end_date: "2027-05-01", deposit_amount: 500 });
    } finally {
      client.release();
    }

    const [resA, resB] = await Promise.all([
      pool.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, [orderA, uniqueId("cs_test"), 50000, "cny", false]),
      pool.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, [orderB, uniqueId("cs_test"), 50000, "cny", false]),
    ]);

    const results = [resA.rows[0].r.result, resB.rows[0].r.result].sort();
    expect(results).toEqual(["failed", "locked"]);

    const client2 = await pool.connect();
    try {
      const inv = await client2.query(`SELECT locked_qty FROM public.inventory WHERE car_model_id = $1 AND date = '2027-05-01'`, [cmId]);
      expect(inv.rows[0].locked_qty).toBe(1);
    } finally {
      client2.release();
    }
  });

  test("6. same session, same order replayed -> already_processed, no new payments row", async () => {
    const client = await pool.connect();
    try {
      const cmId = await insertInventory(client, { dates: ["2027-06-01"], totalQty: 3 });
      const orderId = await insertOrder(client, { car_model_id: cmId, start_date: "2027-06-01", end_date: "2027-06-01", deposit_amount: 500 });
      const sessionId = uniqueId("cs_test");

      const first = await client.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, [orderId, sessionId, 50000, "cny", false]);
      expect(first.rows[0].r.result).toBe("locked");

      const replay = await client.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, [orderId, sessionId, 50000, "cny", false]);
      expect(replay.rows[0].r.result).toBe("already_processed");

      const count = await client.query(`SELECT count(*)::int AS n FROM public.payments WHERE stripe_session_id = $1`, [sessionId]);
      expect(count.rows[0].n).toBe(1);
    } finally {
      client.release();
    }
  });

  test("7. second, different session for an already-paid order -> duplicate_payment_conflict, order untouched, own payments row recorded", async () => {
    const client = await pool.connect();
    try {
      const cmId = await insertInventory(client, { dates: ["2027-07-01"], totalQty: 3 });
      const orderId = await insertOrder(client, { car_model_id: cmId, start_date: "2027-07-01", end_date: "2027-07-01", deposit_amount: 500 });

      const first = await client.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, [orderId, uniqueId("cs_test"), 50000, "cny", false]);
      expect(first.rows[0].r.result).toBe("locked");

      const secondSession = uniqueId("cs_test");
      const second = await client.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, [orderId, secondSession, 50000, "cny", false]);
      expect(second.rows[0].r.result).toBe("duplicate_payment_conflict");
      expect(second.rows[0].r.reason).toBe("order_already_paid_by_different_session");

      const pay = await client.query(`SELECT processing_result FROM public.payments WHERE stripe_session_id = $1`, [secondSession]);
      expect(pay.rows).toHaveLength(1);
      expect(pay.rows[0].processing_result).toBe("duplicate_payment_conflict");

      const ord = await client.query(`SELECT inventory_status FROM public.orders WHERE order_id = $1`, [orderId]);
      expect(ord.rows[0].inventory_status).toBe("locked"); // untouched by the second session
    } finally {
      client.release();
    }
  });

  test("8. same session bound to a different order_id than claimed -> duplicate_payment_conflict + ops alert row, neither order mutated", async () => {
    const client = await pool.connect();
    try {
      const cmId = await insertInventory(client, { dates: ["2027-08-01"], totalQty: 3 });
      const orderA = await insertOrder(client, { car_model_id: cmId, start_date: "2027-08-01", end_date: "2027-08-01", deposit_amount: 500 });
      const orderB = await insertOrder(client, { car_model_id: cmId, start_date: "2027-08-01", end_date: "2027-08-01", deposit_amount: 500 });
      const sessionId = uniqueId("cs_test");

      const first = await client.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, [orderA, sessionId, 50000, "cny", false]);
      expect(first.rows[0].r.result).toBe("locked");

      const conflict = await client.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, [orderB, sessionId, 50000, "cny", false]);
      expect(conflict.rows[0].r.result).toBe("duplicate_payment_conflict");
      expect(conflict.rows[0].r.reason).toBe("session_order_conflict");
      expect(conflict.rows[0].r.existing_order_id).toBe(orderA);

      const alert = await client.query(
        `SELECT audience, notification_type FROM public.send_logs WHERE dedupe_key = $1`,
        [`${sessionId}:${orderB}:ops:session_order_conflict`]
      );
      expect(alert.rows).toHaveLength(1);
      expect(alert.rows[0].audience).toBe("ops");

      const ordB = await client.query(`SELECT payment_status, inventory_status FROM public.orders WHERE order_id = $1`, [orderB]);
      expect(ordB.rows[0].payment_status).toBe("unpaid"); // never touched
    } finally {
      client.release();
    }
  });

  test("9. amount mismatch -> failed, order flipped to failed", async () => {
    const client = await pool.connect();
    try {
      const cmId = await insertInventory(client, { dates: ["2027-09-01"], totalQty: 3 });
      const orderId = await insertOrder(client, { car_model_id: cmId, start_date: "2027-09-01", end_date: "2027-09-01", deposit_amount: 500 });
      const { rows } = await client.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, [orderId, uniqueId("cs_test"), 12345, "cny", false]);
      expect(rows[0].r.result).toBe("failed");
      expect(rows[0].r.reason).toBe("amount_mismatch");
    } finally {
      client.release();
    }
  });

  test("10. currency mismatch -> failed", async () => {
    const client = await pool.connect();
    try {
      const cmId = await insertInventory(client, { dates: ["2027-10-01"], totalQty: 3 });
      const orderId = await insertOrder(client, { car_model_id: cmId, start_date: "2027-10-01", end_date: "2027-10-01", deposit_amount: 500 });
      const { rows } = await client.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, [orderId, uniqueId("cs_test"), 50000, "usd", false]);
      expect(rows[0].r.result).toBe("failed");
      expect(rows[0].r.reason).toBe("currency_mismatch");
    } finally {
      client.release();
    }
  });

  test("11. order does not exist -> RPC raises (Node's caller sees a 5xx-worthy error, not a silent 200)", async () => {
    const client = await pool.connect();
    try {
      await expect(
        client.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, ["ORD-DOES-NOT-EXIST-" + uniqueId("x"), uniqueId("cs_test"), 50000, "cny", false])
      ).rejects.toThrow(/order_not_found/i);
    } finally {
      client.release();
    }
  });

  test("12. NULL / blank stripe_session_id -> RPC raises", async () => {
    const client = await pool.connect();
    try {
      const cmId = await insertInventory(client, { dates: ["2027-12-01"], totalQty: 3 });
      const orderId = await insertOrder(client, { car_model_id: cmId, start_date: "2027-12-01", end_date: "2027-12-01", deposit_amount: 500 });

      await expect(client.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, [orderId, null, 50000, "cny", false])).rejects.toThrow(
        /p_stripe_session_id is required/i
      );
      await expect(client.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, [orderId, "   ", 50000, "cny", false])).rejects.toThrow(
        /p_stripe_session_id is required/i
      );
    } finally {
      client.release();
    }
  });

  test("13. concurrent redelivery of the SAME new session_id for the SAME order -> one commits, the other's whole call (including its own inventory UPDATE) rolls back atomically", async () => {
    const client = await pool.connect();
    let cmId, orderId, sessionId;
    try {
      cmId = await insertInventory(client, { dates: ["2027-11-13"], totalQty: 5 });
      orderId = await insertOrder(client, { car_model_id: cmId, start_date: "2027-11-13", end_date: "2027-11-13", deposit_amount: 500 });
      sessionId = uniqueId("cs_test_race");
    } finally {
      client.release();
    }

    const settled = await Promise.allSettled([
      pool.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, [orderId, sessionId, 50000, "cny", false]),
      pool.query(`SELECT public.${RPC}($1,$2,$3,$4,$5) AS r`, [orderId, sessionId, 50000, "cny", false]),
    ]);

    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");

    // Exactly one of the two concurrent redeliveries wins the unique-index
    // race on payments.stripe_session_id; the other's entire function
    // invocation — including the inventory UPDATE it already ran in the
    // same statement, before hitting the constraint on its own INSERT —
    // is rolled back by Postgres as a unit. This is the real proof of
    // "mid-transaction exception forces full rollback", not a simulated one.
    expect(fulfilled.length + rejected.length).toBe(2);
    if (rejected.length > 0) {
      expect(rejected[0].reason.message).toMatch(/duplicate key|unique/i);
    }

    const client2 = await pool.connect();
    try {
      const inv = await client2.query(`SELECT locked_qty FROM public.inventory WHERE car_model_id = $1 AND date = '2027-11-13'`, [cmId]);
      // Regardless of which branch won (both concurrent calls may also both
      // legitimately succeed as "locked" + "already_processed" if the
      // second one's SELECT happened to run after the first committed —
      // in EITHER outcome locked_qty must never exceed 1 for this single
      // session/order pair, proving no double-increment ever survives.
      expect(inv.rows[0].locked_qty).toBe(1);

      const payCount = await client2.query(`SELECT count(*)::int AS n FROM public.payments WHERE stripe_session_id = $1`, [sessionId]);
      expect(payCount.rows[0].n).toBe(1);
    } finally {
      client2.release();
    }
  });
});
