// __tests__/helpers/mockReqRes.js
// Minimal Node-style (req, res) mocks for Next.js "pages/api" handlers.

function createMockReq({ method = "POST", body = {}, query = {} } = {}) {
  return { method, body, query };
}

function createMockRes() {
  const res = {};
  res.statusCode = 200;
  res.headers = {};
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((payload) => {
    res.body = payload;
    return res;
  });
  res.setHeader = jest.fn((name, value) => {
    res.headers[String(name).toLowerCase()] = value;
    return res;
  });
  res.getHeader = jest.fn((name) => res.headers[String(name).toLowerCase()]);
  res.end = jest.fn(() => res);
  return res;
}

module.exports = { createMockReq, createMockRes };
