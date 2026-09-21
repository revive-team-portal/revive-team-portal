// Guarded manual Shopify backfill/sync. ?k=..&start=YYYY-MM-DD&end=YYYY-MM-DD
const { syncShopify } = require('./_shopifysync');
const { guard } = require('./_runkey');
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (!(await guard(event)).ok) return { statusCode: 403, body: 'nope' };
  const end = qp.end || new Date().toISOString().slice(0, 10);
  const start = qp.start || '2022-01-01';
  try { const s = await syncShopify(start, end); return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, ...s }) }; }
  catch (e) { return { statusCode: 500, body: String(e.message || e) }; }
};
