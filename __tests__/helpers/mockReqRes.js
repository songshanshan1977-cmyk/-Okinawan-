// __tests__/helpers/mockReqRes.js
// Minimal Node-style (req, res) mocks for Next.js "pages/api" handlers.

function createMockReq({ method = "POST", body = {}, query = {} } = {}) {
  return { method, body, query };
}

function createMockRes() {
  const res = {};
  res.statusCode = 200;
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((payload) => {
    res.body = payload;
    return res;
  });
  res.end = jest.fn(() => res);
  return res;
}

module.exports = { createMockReq, createMockRes };
