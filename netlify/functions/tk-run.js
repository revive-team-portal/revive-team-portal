const { runSync } = require('./_tksync');
const GUARD = 'rvp-tk-7Kq3';
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  const n = Math.min(Math.max(parseInt(qp.weeks || 6, 10) || 6, 1), 12);
  try { const s = await runSync(n); return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, summary: s }, null, 1) }; }
  catch (e) { return { statusCode: 500, body: String(e.message || e) }; }
};
