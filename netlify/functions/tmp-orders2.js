// TEMPORARY read-only per-order attribution. Delete after use. ?k=<key>&start=&end= (NZ dates)
const { gql } = require('./_shopify');
const KEY = 'r7f2Qx91TmpAudit';
const shift = (ymd, n) => { const x = new Date(ymd + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const F = `
  name createdAt
  currentTotalPriceSet{ shopMoney{ amount } }
  customer{ numberOfOrders }
  discountCodes
  customerJourneySummary{ momentsCount{ count } daysToConversion customerOrderIndex
    firstVisit{ source sourceType utmParameters{ source medium campaign } }
    lastVisit{ source sourceType utmParameters{ source medium campaign } }
    moments(first: 25){ nodes{ occurredAt ... on CustomerVisit { source sourceType utmParameters{ source medium campaign } } } } }`;
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== KEY) return { statusCode: 403, body: 'nope' };
  const q = 'created_at:>=' + qp.start + 'T00:00:00+12:00 AND created_at:<' + shift(qp.end, 1) + 'T00:00:00+12:00';
  const Q = 'query($q:String!,$after:String){ orders(first:60, query:$q, after:$after, sortKey:CREATED_AT){ pageInfo{ hasNextPage endCursor } nodes{ ' + F + ' } } }';
  try {
    let after = null, nodes = [];
    for (let i = 0; i < 25; i++) {
      const d = await gql(Q, { q, after });
      const o = d.orders || (d.data && d.data.orders);
      o.nodes.forEach(n => nodes.push(n));
      if (!o.pageInfo.hasNextPage) break;
      after = o.pageInfo.endCursor;
    }
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ count: nodes.length, orders: nodes }, null, 1) };
  } catch (e) { return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(e.message || e) }) }; }
};
