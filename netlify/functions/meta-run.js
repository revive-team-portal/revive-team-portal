// Guarded manual Meta backfill/sync. ?k=..&start=YYYY-MM-DD&end=YYYY-MM-DD
const { syncMeta, fetchTotal } = require('./_metasync');
const GUARD = 'rvp-tk-7Kq3';
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  if (qp.mode === 'agg') { try { const total = await fetchTotal(qp.start, qp.end); return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, apiTotal: total }) }; } catch (e) { return { statusCode: 500, body: String(e.message || e) }; } }
  const end = qp.end || new Date().toISOString().slice(0, 10);
  const start = qp.start || '2024-01-01';
  try { const s = await syncMeta(start, end); return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, ...s }) }; }
  catch (e) { return { statusCode: 500, body: String(e.message || e) }; }
};
