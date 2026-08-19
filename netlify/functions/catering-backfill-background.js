const { syncCatering } = require('./_shopifycatering');
const GUARD = process.env.PORTAL_RUN_KEY;
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  const end = qp.end || new Date().toISOString().slice(0, 10);
  const start = qp.start || '2023-01-01';
  try { const s = await syncCatering(start, end); console.log('catering-backfill', JSON.stringify(s)); return { statusCode: 200, body: JSON.stringify(s) }; }
  catch (e) { console.log('catering-backfill error', String(e && e.message || e)); return { statusCode: 500, body: String(e) }; }
};
