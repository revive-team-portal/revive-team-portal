const { TODAY_SQL, queueJob, db } = require('./_posqueries');
const { gql } = require('./_shopify');
const { rest } = require('./_appsdb');
const NZ = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });
function nzToday() { return NZ.format(new Date()); }

async function orderCounts() {
  try {
    const t = nzToday();
    const d = await gql('{ a: ordersCount(query:"fulfillment_status:unfulfilled status:open"){ count } b: ordersCount(query:"fulfillment_status:fulfilled updated_at:>=' + t + '"){ count } }');
    return { orders_to_fulfil: d && d.a ? d.a.count : null, orders_fulfilled_today: d && d.b ? d.b.count : null };
  } catch (e) { return { orders_to_fulfil: null, orders_fulfilled_today: null }; }
}
async function shopifySums() {
  try {
    const today = nzToday();
    // start of current Sat–Fri week (most recent Saturday on/before today)
    const d = new Date(today + 'T00:00:00Z'); const back = (d.getUTCDay() - 6 + 7) % 7; d.setUTCDate(d.getUTCDate() - back);
    const weekStart = d.toISOString().slice(0, 10);
    const Q = 'query($q:String!,$after:String){ orders(first:250, query:$q, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ createdAt currentTotalPriceSet{ shopMoney{ amount } } } } }';
    let after = null, weekSum = 0, todaySum = 0;
    for (let g = 0; g < 20; g++) {
      const r = await gql(Q, { q: 'created_at:>=' + weekStart, after });
      const o = r && r.orders; if (!o) break;
      for (const n of o.nodes) {
        const amt = Number((n.currentTotalPriceSet && n.currentTotalPriceSet.shopMoney && n.currentTotalPriceSet.shopMoney.amount) || 0);
        weekSum += amt;
        if (NZ.format(new Date(n.createdAt)) === today) todaySum += amt;
      }
      if (!o.pageInfo.hasNextPage) break; after = o.pageInfo.endCursor;
    }
    return { shopify_today: Math.round(todaySum * 100) / 100, shopify_week: Math.round(weekSum * 100) / 100 };
  } catch (e) { return { shopify_today: null, shopify_week: null }; }
}
async function outstandingTickets() {
  try { const rows = await rest('tickets?status=neq.Resolved&select=id&limit=1000'); return { outstanding_tickets: Array.isArray(rows) ? rows.length : null }; }
  catch (e) { return { outstanding_tickets: null }; }
}
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  try {
    if (qp.refresh) await queueJob('cafe-today', TODAY_SQL).catch(() => {});
    const [rows, oc, ss, tk] = await Promise.all([db('pos_today?id=eq.1&select=sales,covers,updated_at'), orderCounts(), shopifySums(), outstandingTickets()]);
    const t = (rows && rows[0]) || {};
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ sales: t.sales, covers: t.covers, updated_at: t.updated_at,
        shopify_today: ss.shopify_today, shopify_week: ss.shopify_week,
        orders_to_fulfil: oc.orders_to_fulfil, orders_fulfilled_today: oc.orders_fulfilled_today, outstanding_tickets: tk.outstanding_tickets }) };
  } catch (e) { return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(e.message || e) }) }; }
};
