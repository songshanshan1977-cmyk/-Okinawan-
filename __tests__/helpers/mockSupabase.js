// __tests__/helpers/mockSupabase.js
//
// Minimal chainable Supabase query-builder mock. Zero network I/O.
// Each `.from(table)` call consumes the next queued fixture for that table
// (or reuses the last one if the queue only has one entry), so a single
// test can script a sequence of calls against the same table (e.g. a
// "select existing" read followed by an "update" write).

// `tableCallLog` accumulates calls across every `.from(table)` invocation for
// that table within a single test, so callers can inspect e.g.
// `supabase.__tableCalls.orders.insert` / `.update` after the handler ran,
// without needing to call `.from()` again (which would hand back a brand
// new, empty chain and silently show zero calls).
function createChainable(result, tableCallLog) {
  const chain = {};
  const methods = ["select", "eq", "in", "order", "limit", "update", "insert", "upsert", "delete"];
  methods.forEach((m) => {
    tableCallLog[m] = tableCallLog[m] || jest.fn();
    chain[m] = jest.fn((...args) => {
      tableCallLog[m](...args);
      return chain;
    });
  });
  chain.single = jest.fn(() => Promise.resolve(result));
  chain.maybeSingle = jest.fn(() => Promise.resolve(result));
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function createMockSupabase({ from = {}, rpc } = {}) {
  const queues = {};
  for (const [table, results] of Object.entries(from)) {
    queues[table] = Array.isArray(results) ? [...results] : [results];
  }

  const calls = { from: [], rpc: [] };
  const tableCalls = {};

  const fromMock = jest.fn((table) => {
    calls.from.push(table);
    const q = queues[table];
    if (!q) {
      throw new Error(`mockSupabase: no fixture registered for table "${table}"`);
    }
    const result = q.length > 1 ? q.shift() : q[0];
    tableCalls[table] = tableCalls[table] || {};
    return createChainable(result, tableCalls[table]);
  });

  const rpcMock = jest.fn((name, args) => {
    calls.rpc.push({ name, args });
    if (typeof rpc === "function") return Promise.resolve(rpc(name, args));
    return Promise.resolve({ data: null, error: null });
  });

  return { from: fromMock, rpc: rpcMock, __calls: calls, __tableCalls: tableCalls };
}

module.exports = { createChainable, createMockSupabase };
