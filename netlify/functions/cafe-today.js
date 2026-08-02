const { TODAY_SQL, queueJob, db } = require('./_posqueries');
const { gql } = require('./_shopify');
function nzToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
async function orderCounts() {
  try {
    const t = nzToday();
    const d = await gql('{ a: ordersCount(query:"fulfillment_status:unfulfilled status:open"){ count } b: ordersCount(query:"fulfillment_status:fulfilled updated_at:>=' + t + '"){ count } }');
    return { orders_to_fulfil: d && d.a ? d.a.count : null, orders_fulfilled_today: d && d.b ? d.b.count : null };
  } catch (e) { return { orders_to_fulfil: null, orders_fulfilled_today: null }; }
}
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  try {
    if (qp.refresh) await queueJob('cafe-today', TODAY_SQL).catch(() => {});
    const [rows, oc] = await Promise.all([db('pos_today?id=eq.1&select=sales,covers,updated_at'), orderCounts()]);
    const t = (rows && rows[0]) || {};
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ sales: t.sales, covers: t.covers, updated_at: t.updated_at, orders_to_fulfil: oc.orders_to_fulfil, orders_fulfilled_today: oc.orders_fulfilled_today }) };
  } catch (e) { return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(e.message || e) }) }; }
};
