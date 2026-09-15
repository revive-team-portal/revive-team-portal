// TEMPORARY read-only export of order create/fulfil timestamps for a fulfilment-speed metric.
// ?k=<key>&month=YYYY-MM (NZ month). Writes nothing. Delete after use.
const { gql } = require('./_shopify');
const KEY = 'VjBHZ8kPp0M7nia2Vu4fDwwq';
const shiftMonth = (ym) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m, 1)); return d.toISOString().slice(0, 7); };
exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  if (p.k !== KEY) return { statusCode: 401, body: 'nope' };
  const month = p.month; if (!/^\d{4}-\d{2}$/.test(month || '')) return { statusCode: 400, body: 'month' };
  const q = 'created_at:>=' + month + '-01T00:00:00+12:00 AND created_at:<' + shiftMonth(month) + '-01T00:00:00+12:00';
  const Q = 'query($q:String!,$after:String){ orders(first:250, query:$q, after:$after, sortKey:CREATED_AT){ pageInfo{ hasNextPage endCursor } nodes{ name createdAt cancelledAt test sourceName displayFulfillmentStatus shippingLine{ title } fulfillments(first:5){ createdAt status } } } }';
  const rows = []; let after = null;
  try {
    for (let i = 0; i < 40; i++) {
      const d = await gql(Q, { q, after });
      for (const o of d.orders.nodes) rows.push([o.name, o.createdAt, o.cancelledAt, o.test, o.sourceName, o.displayFulfillmentStatus, o.shippingLine ? o.shippingLine.title : null, (o.fulfillments || []).map(f => [f.createdAt, f.status])]);
      if (!d.orders.pageInfo.hasNextPage) break; after = d.orders.pageInfo.endCursor;
    }
  } catch (e) { return { statusCode: 500, body: String(e.message || e) }; }
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month, n: rows.length, rows }) };
};
