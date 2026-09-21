const { syncCatering } = require('./_shopifycatering');
const { guard, DENY } = require('./_runkey');
// Default: last 70 days. Backfill: ?start=YYYY-MM-DD&end=YYYY-MM-DD (replaces catering-backfill-background).
exports.handler = async (event) => {
  if (!(await guard(event)).ok) return DENY;
  const qp = (event && event.queryStringParameters) || {};
  const end = qp.end || new Date().toISOString().slice(0, 10);
  const d = new Date(); d.setUTCDate(d.getUTCDate() - 70); const start = qp.start || d.toISOString().slice(0, 10);
  try { const s = await syncCatering(start, end); console.log('catering-sync', JSON.stringify(s)); return { statusCode: 200, body: JSON.stringify(s) }; }
  catch (e) { console.log('catering-sync error', String(e && e.message || e)); return { statusCode: 500, body: String(e) }; }
};
