const { runSync, fetchWeekEntries, addDays } = require('./_tksync');
const GUARD = 'rvp-tk-7Kq3';
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  const n = Math.min(Math.max(parseInt(qp.weeks || 6, 10) || 6, 1), 15);
  const daysOnly = qp.mode === 'days';
  if (qp.mode === 'raw') {
    try {
      const F = qp.week || new Date().toISOString().slice(0,10);
      const es = await fetchWeekEntries(addDays(F,-6), F);
      const e = es[0] || {};
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: es.length, keys: Object.keys(e), sample: e }, null, 1) };
    } catch (e) { return { statusCode: 500, body: String(e.message || e) }; }
  }
  try { const s = await runSync(n, daysOnly); return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, summary: s }, null, 1) }; }
  catch (e) { return { statusCode: 500, body: String(e.message || e) }; }
};
