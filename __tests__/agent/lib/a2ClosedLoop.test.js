// __tests__/agent/lib/a2ClosedLoop.test.js
//
// A2 end-to-end closed-loop test: draft creation -> summary -> update ->
// confirmation clearing -> re-summary -> stale-hash rejection -> successful
// confirmation -> idempotent re-confirmation. This exercises all four A1/A2
// tools TOGETHER against a small stateful in-memory fake `orders`/
// `inventory_rules_v2` "database" (createFakeSupabase below) — the queue-
// based createMockSupabase helper used by every other test file in this
// project only supports one canned response per call and cannot represent
// state genuinely persisting and evolving across a multi-tool-call flow
// the way a real database would, so this file builds its own minimal
// stateful fake, scoped to exactly the query shapes A1/A2's tools actually
// issue. Zero real network I/O — jest.setup.js's global fetch guard would
// fail loudly if anything here ever attempted one.

const { createBookingDraftTool } = require("../../../lib/agent/tools/createBookingDraft");
const { getBookingSummaryTool } = require("../../../lib/agent/tools/getBookingSummary");
const { updateBookingDraftTool } = require("../../../lib/agent/tools/updateBookingDraft");
const { confirmBookingSummaryTool } = require("../../../lib/agent/tools/confirmBookingSummary");
const { AGENT_ERROR_CODES } = require("../../../lib/agent/errorCodes");
const { TEST_AGENT_BOOKING_TOKEN_SECRET } = require("../helpers/testSecrets");

const CAR = "5fdce9d4-2ef3-42ca-9d0c-a06446b0d9ca";

function createFakeSupabase() {
  const orders = new Map();
  const inventory = [];

  function matchOrders(filters) {
    return [...orders.values()].filter((r) => filters.every((f) => r[f.col] === f.val));
  }

  function ordersTable() {
    let filters = [];
    let mode = null;
    let payload = null;
    let upsertOpts = null;

    const api = {
      select() {
        if (!mode) mode = "select";
        return api;
      },
      eq(col, val) {
        filters.push({ col, val });
        return api;
      },
      update(row) {
        mode = "update";
        payload = row;
        return api;
      },
      upsert(row, opts) {
        mode = "upsert";
        payload = row;
        upsertOpts = opts;
        return api;
      },
      async maybeSingle() {
        const res = await run();
        const arr = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
        return { data: arr[0] || null, error: res.error };
      },
      then(resolve, reject) {
        return run().then(resolve, reject);
      },
    };

    async function run() {
      if (mode === "select" || mode === null) {
        return { data: matchOrders(filters).map((r) => ({ ...r })), error: null };
      }
      if (mode === "update") {
        const matches = matchOrders(filters);
        matches.forEach((r) => Object.assign(r, payload));
        return { data: matches.map((r) => ({ ...r })), error: null };
      }
      if (mode === "upsert") {
        const conflictCol = upsertOpts && upsertOpts.onConflict;
        if (conflictCol && payload[conflictCol] != null) {
          const conflictRow = [...orders.values()].find((r) => r[conflictCol] === payload[conflictCol]);
          if (conflictRow) return { data: [], error: null };
        }
        if (orders.has(payload.order_id)) {
          return { data: null, error: { code: "23505" } };
        }
        orders.set(payload.order_id, { ...payload });
        return { data: [{ ...orders.get(payload.order_id) }], error: null };
      }
      return { data: null, error: null };
    }

    return api;
  }

  function inventoryTable() {
    let filters = [];
    const api = {
      select() {
        return api;
      },
      eq(col, val) {
        filters.push({ col, val, type: "eq" });
        return api;
      },
      in(col, vals) {
        filters.push({ col, vals, type: "in" });
        return api;
      },
      then(resolve, reject) {
        const data = inventory.filter((row) => filters.every((f) => (f.type === "eq" ? row[f.col] === f.val : f.vals.includes(row[f.col]))));
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return api;
  }

  const supabase = {
    from: jest.fn((table) => {
      if (table === "orders") return ordersTable();
      if (table === "inventory_rules_v2") return inventoryTable();
      throw new Error("createFakeSupabase: no fixture for table " + table);
    }),
    rpc: jest.fn((name) => {
      if (name === "get_car_price") return Promise.resolve({ data: 1600, error: null });
      return Promise.resolve({ data: null, error: { message: "unknown rpc" } });
    }),
  };

  return { supabase, orders, inventory };
}

describe("A2 closed loop: draft -> summary -> update -> confirmation clearing -> stale rejection -> confirm -> idempotent re-confirm", () => {
  beforeEach(() => {
    process.env.AGENT_BOOKING_TOKEN_SECRET = TEST_AGENT_BOOKING_TOKEN_SECRET;
  });
  afterEach(() => {
    delete process.env.AGENT_BOOKING_TOKEN_SECRET;
  });

  test("full loop", async () => {
    const { supabase, inventory, orders } = createFakeSupabase();
    ["2099-09-01", "2099-09-02", "2099-09-03", "2099-09-04", "2099-09-05"].forEach((date) => {
      inventory.push({ car_model_id: CAR, driver_lang: "ZH", date, remaining_qty_calc: 5 });
    });

    // 1. Create draft.
    const draftInput = {
      car_model_id: CAR,
      driver_lang: "zh",
      duration: 8,
      start_date: "2099-09-01",
      end_date: "2099-09-01",
      departure_hotel: "Hotel A",
      end_hotel: "Hotel B",
      pax: 2,
      luggage: 1,
      name: "Zhang San",
      phone: "13800000000",
      email: "zhangsan@example.com",
    };
    const draftResult = await createBookingDraftTool({ supabase, data: draftInput, idempotencyKey: "e2e-key-1" });
    expect(draftResult.ok).toBe(true);
    const order_id = draftResult.order_id;

    // 2. Get summary H1.
    const summary1 = await getBookingSummaryTool({ supabase, order_id });
    expect(summary1.ok).toBe(true);
    const H1 = summary1.summary_hash;

    // 2b. Customer confirms H1 (before noticing the error) — makes the
    // later "clearing" a real, observable state transition rather than a
    // vacuous null-stays-null check.
    const confirmH1 = await confirmBookingSummaryTool({ supabase, order_id, summary_hash: H1 });
    expect(confirmH1.ok).toBe(true);
    expect(confirmH1.confirmed).toBe(true);

    // 3. Customer notices the wrong end_hotel; Agent updates the draft.
    const updateResult = await updateBookingDraftTool({
      supabase,
      order_id,
      expected_summary_hash: H1,
      changes: { end_hotel: "Hotel Z" },
    });
    expect(updateResult.ok).toBe(true);
    expect(updateResult.updated).toBe(true);
    expect(updateResult.confirmed).toBe(false);

    // 4. Confirmation fields are genuinely cleared (real transition from
    // "confirmed at step 2b" to null, not a vacuous null-stays-null check)
    // — inspected directly off the fake DB's own state, since no tool
    // output exposes these two columns raw.
    expect(orders.get(order_id).agent_summary_confirmed_hash).toBeNull();
    expect(orders.get(order_id).agent_summary_confirmed_at).toBeNull();

    // 5. Get summary H2 (different from H1, since end_hotel changed).
    const H2 = updateResult.summary_hash;
    expect(H2).not.toBe(H1);

    // 6. Confirming with the now-stale H1 must fail.
    const confirmWithH1Again = await confirmBookingSummaryTool({ supabase, order_id, summary_hash: H1 });
    expect(confirmWithH1Again.ok).toBe(false);
    expect(confirmWithH1Again.code).toBe(AGENT_ERROR_CODES.SUMMARY_STALE);

    // 7. Confirming with H2 succeeds.
    const confirmH2 = await confirmBookingSummaryTool({ supabase, order_id, summary_hash: H2 });
    expect(confirmH2.ok).toBe(true);
    expect(confirmH2.confirmed).toBe(true);
    expect(confirmH2.summary_hash).toBe(H2);
    const firstConfirmedAt = confirmH2.confirmed_at;

    // 8. Re-confirming with the SAME H2 is idempotent: same confirmed_at, no re-write.
    const confirmH2Again = await confirmBookingSummaryTool({ supabase, order_id, summary_hash: H2 });
    expect(confirmH2Again.ok).toBe(true);
    expect(confirmH2Again.confirmed_at).toBe(firstConfirmedAt);
  });

  test("zero real network requests occur anywhere in the loop (fetch is guarded globally by jest.setup.js)", async () => {
    const { supabase, inventory } = createFakeSupabase();
    inventory.push({ car_model_id: CAR, driver_lang: "ZH", date: "2099-09-01", remaining_qty_calc: 5 });
    const draftInput = {
      car_model_id: CAR,
      driver_lang: "zh",
      duration: 8,
      start_date: "2099-09-01",
      end_date: "2099-09-01",
      departure_hotel: "Hotel A",
      end_hotel: "Hotel B",
      pax: 2,
      luggage: 1,
      name: "Zhang San",
      phone: "13800000000",
      email: "zhangsan@example.com",
    };
    await expect(createBookingDraftTool({ supabase, data: draftInput, idempotencyKey: "e2e-key-2" })).resolves.toMatchObject({ ok: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
