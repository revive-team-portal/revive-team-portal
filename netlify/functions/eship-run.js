const { syncShipping } = require('./_eshipsync');
const { guard } = require('./_runkey');
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (!(await guard(event)).ok) return { statusCode: 403, body: 'nope' };
  const since = qp.since || null;
  const max = Math.min(Math.max(parseInt(qp.max || 10, 10) || 10, 1), 800);
  try { const s = await syncShipping(since, max); return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s, null, 1) }; }
  catch (e) { return { statusCode: 500, body: String(e.message || e) }; }
};
