// __tests__/helpers/mockReqRes.js
//
// Minimal fake Next.js API req/res for testing pages/api/stripe-webhook.js
// directly as a function, without spinning up a real HTTP server. `req` is
// an async-iterable of Buffer chunks (matching what the handler's own
// `buffer(req)` helper expects from a real Node request stream).

function createMockReq({ method = "POST", body = "{}", signature = "test-sig" } = {}) {
  const bodyBuffer = Buffer.from(body);
  return {
    method,
    headers: { "stripe-signature": signature },
    [Symbol.asyncIterator]: async function* () {
      yield bodyBuffer;
    },
  };
}

function createMockRes() {
  const res = {};
  res.statusCode = null;
  res.body = undefined;
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((obj) => {
    res.body = obj;
    return res;
  });
  res.send = jest.fn((s) => {
    res.body = s;
    return res;
  });
  res.end = jest.fn(() => res);
  return res;
}

module.exports = { createMockReq, createMockRes };
