export default async function handler(req, res) {
  return res.json({
    debug: true,
    received: req.body,
    time: new Date().toISOString(),
  });
}
