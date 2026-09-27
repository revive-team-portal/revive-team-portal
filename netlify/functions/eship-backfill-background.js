// Manual eShip history backfill (NOT scheduled, so it can be invoked over HTTP).
// ?k=<runkey>&since=YYYY-MM-DD&max=N — background (15 min). Skips orders already captured.
const { syncShipping } = require('./_eshipsync');
const { guard, DENY } = require('./_runkey');
exports.handler = async (event) => {
  if (!(await guard(event)).ok) return DENY;
  const qp = (event && event.queryStringParameters) || {};
  const since = qp.since || '2026-06-20';
  const max = Math.min(Math.max(parseInt(qp.max || 450, 10) || 450, 1), 700);
  try { const s = await syncShipping(since, max); console.log('eship-backfill', JSON.stringify(s)); return { statusCode: 200, body: JSON.stringify(s) }; }
  catch (e) { console.log('eship-backfill error', String(e && e.message || e)); return { statusCode: 500, body: String(e) }; }
};
