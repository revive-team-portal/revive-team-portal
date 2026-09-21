const { runSync } = require('./_tksync');
const { guard } = require('./_runkey');
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (!(await guard(event)).ok) return { statusCode: 403, body: 'nope' };
  const n = Math.min(Math.max(parseInt(qp.weeks || 6, 10) || 6, 1), 15);
  const daysOnly = qp.mode === 'days';
  try { const s = await runSync(n, daysOnly); return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, summary: s }, null, 1) }; }
  catch (e) { return { statusCode: 500, body: String(e.message || e) }; }
};
