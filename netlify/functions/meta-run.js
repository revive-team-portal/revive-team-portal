// Guarded manual Meta backfill/sync. ?k=..&start=YYYY-MM-DD&end=YYYY-MM-DD
const { syncMeta, metaAccountTz, fetchInsights } = require('./_metasync');
const GUARD = 'rvp-tk-7Kq3';
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  if (qp.mode === 'diag') {
    try {
      const tz = await metaAccountTz();
      const end = qp.end || new Date().toISOString().slice(0, 10);
      const d = new Date(); d.setUTCDate(d.getUTCDate() - (parseInt(qp.days||16,10))); const start = d.toISOString().slice(0,10);
      const days = await fetchInsights(start, end);
      const rows = days.map(x => [x.date_start, Number(x.spend)||0]);
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tz, serverToday: end, rows }, null, 0) };
    } catch (e) { return { statusCode: 500, body: String(e.message || e) }; }
  }
  const end = qp.end || new Date().toISOString().slice(0, 10);
  const start = qp.start || '2024-01-01';
  try { const s = await syncMeta(start, end); return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, ...s }) }; }
  catch (e) { return { statusCode: 500, body: String(e.message || e) }; }
};
