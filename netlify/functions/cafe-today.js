const { TODAY_SQL, queueJob, db } = require('./_posqueries');
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  try {
    if (qp.refresh) await queueJob('cafe-today', TODAY_SQL).catch(() => {});
    const rows = await db('pos_today?id=eq.1&select=sales,covers,updated_at');
    const t = (rows && rows[0]) || {};
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ sales: t.sales, covers: t.covers, updated_at: t.updated_at }) };
  } catch (e) { return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(e.message || e) }) }; }
};
