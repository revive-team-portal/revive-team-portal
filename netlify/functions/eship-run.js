const { syncShipping } = require('./_eshipsync');
const GUARD = process.env.PORTAL_RUN_KEY;
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  const since = qp.since || null;
  const max = Math.min(Math.max(parseInt(qp.max || 10, 10) || 10, 1), 400);
  try { const s = await syncShipping(since, max); return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s, null, 1) }; }
  catch (e) { return { statusCode: 500, body: String(e.message || e) }; }
};
