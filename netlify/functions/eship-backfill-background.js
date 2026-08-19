const { syncShipping } = require('./_eshipsync');
const GUARD = process.env.PORTAL_RUN_KEY;
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (!GUARD || qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  const since = qp.since || null;
  const max = Math.min(Math.max(parseInt(qp.max || 700, 10) || 700, 1), 800);
  try { const s = await syncShipping(since, max); console.log('eship-backfill', JSON.stringify(s)); return { statusCode: 200, body: JSON.stringify(s) }; }
  catch (e) { console.log('eship-backfill error', String(e && e.message || e)); return { statusCode: 500, body: String(e) }; }
};
