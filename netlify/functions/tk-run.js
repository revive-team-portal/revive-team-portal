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
      let nn = 0, sum = 0, hrs = 0;
      for (const x of es) { const c = x.estimated_time_entry_cost; if (c != null) { nn++; sum += Number(c) || 0; } hrs += Number(x.duration_in_hours_raw) || 0; }
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: es.length, keys: Object.keys(e), costNonNull: nn, costSum: Math.round(sum*100)/100, totalHours: Math.round(hrs*10)/10, sample: e }, null, 1) };
    } catch (e) { return { statusCode: 500, body: String(e.message || e) }; }
  }
  try { const s = await runSync(n, daysOnly); return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, summary: s }, null, 1) }; }
  catch (e) { return { statusCode: 500, body: String(e.message || e) }; }
};
