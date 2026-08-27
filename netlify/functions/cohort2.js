// TEMPORARY cohort LTV audit. ?k=<guard>&start=YYYY-MM-DD&end=YYYY-MM-DD
const { gql } = require('./_shopify');
const GUARD = '96ea0c608768a18f95b9e0e36be9d724';
const QC = `query($q:String!,$after:String){ customers(first:250, query:$q, after:$after, sortKey:CREATED_AT){
  pageInfo{ hasNextPage endCursor }
  nodes{ id createdAt numberOfOrders amountSpent{ amount } } } }`;

exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  const q = 'created_at:>=' + qp.start + ' AND created_at:<' + qp.end;
  const rows = []; let after = null; let pages = 0;
  try {
    for (let i = 0; i < 25; i++) {
      const d = await gql(QC, { q, after }); pages++;
      d.customers.nodes.forEach(c => rows.push({
        created: c.createdAt, n: Number(c.numberOfOrders) || 0, spent: Number(c.amountSpent.amount) || 0 }));
      if (!d.customers.pageInfo.hasNextPage) break; after = d.customers.pageInfo.endCursor;
    }
  } catch (e) { return { statusCode: 200, body: JSON.stringify({ error: String(e.message || e) }) }; }
  const buyers = rows.filter(r => r.n > 0);
  const calc = (list) => {
    if (!list.length) return null;
    const n = list.length, repeat = list.filter(c => c.n > 1).length;
    const orders = list.reduce((a, c) => a + c.n, 0), spend = list.reduce((a, c) => a + c.spent, 0);
    const dist = {}; list.forEach(c => { const k = c.n >= 5 ? '5+' : String(c.n); dist[k] = (dist[k] || 0) + 1; });
    return { customers: n, repeat_customers: repeat, repeat_rate: +(repeat / n * 100).toFixed(1),
      avg_orders: +(orders / n).toFixed(2), avg_lifetime_spend: +(spend / n).toFixed(2),
      median_ish_dist: dist, total_spend: Math.round(spend) };
  };
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cohort: [qp.start, qp.end], pages, records: rows.length,
      sample_created: rows.slice(0, 2).map(r => r.created), buyers: calc(buyers) }, null, 1) };
};
