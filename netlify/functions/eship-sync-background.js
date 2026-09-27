// Nightly per-order shipping-cost capture from Starshipit (~1 req/sec, cost only on
// order detail). Background (15 min). 1) last 12 days (keeps current weeks complete);
// 2) then chips ~250 older, never-captured orders off the 2-year history each night so
// the backfill completes on its own (dedupe means only missing orders are fetched).
const { syncShipping } = require('./_eshipsync');
exports.handler = async () => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - 12); const since = d.toISOString().slice(0, 10);
  const out = {};
  try { out.recent = await syncShipping(since, 400); } catch (e) { out.recent = 'err ' + String(e && e.message || e).slice(0, 120); }
  try { out.history = await syncShipping('2024-09-20', 250); } catch (e) { out.history = 'err ' + String(e && e.message || e).slice(0, 120); }
  console.log('eship-sync', JSON.stringify(out));
  return { statusCode: 200, body: JSON.stringify(out) };
};
