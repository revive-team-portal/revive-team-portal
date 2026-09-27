// Nightly per-order shipping-cost capture from Starshipit (~1 req/sec, cost only on
// order detail). Background (15 min). Default: last 12 days. Backfill: ?since=YYYY-MM-DD&max=N
const { syncShipping } = require('./_eshipsync');
const { guard } = require('./_runkey');
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  const manual = !!qp.k;
  if (manual && !(await guard(event)).ok) return { statusCode: 403, body: 'nope' };
  const d = new Date(); d.setUTCDate(d.getUTCDate() - 12);
  const since = qp.since || d.toISOString().slice(0, 10);
  const max = Math.min(Math.max(parseInt(qp.max || 500, 10) || 500, 1), 700);
  try { const s = await syncShipping(since, max); console.log('eship-sync', JSON.stringify(s)); return { statusCode: 200, body: JSON.stringify(s) }; }
  catch (e) { console.log('eship-sync error', String(e && e.message || e)); return { statusCode: 500, body: String(e) }; }
};
