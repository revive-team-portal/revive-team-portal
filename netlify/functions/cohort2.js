// TEMPORARY cohort LTV audit. ?k=<guard>&start=YYYY-MM-DD&end=YYYY-MM-DD
const { gql } = require('./_shopify');
const GUARD = '96ea0c608768a18f95b9e0e36be9d724';
const QC = `query($after:String){ customers(first:250, after:$after, sortKey:CREATED_AT, reverse:true){
  pageInfo{ hasNextPage endCursor }
  nodes{ id createdAt numberOfOrders amountSpent{ amount } } } }`;

exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  const STOP = qp.start || '2025-06-01';
  const rows = []; let after = null; let pages = 0; let done = false;
  try {
    for (let i = 0; i < 25; i++) {
      const d = await gql(QC, { after }); pages++;
      for (const c of d.customers.nodes) {
        if (c.createdAt < STOP) { done = true; break; }
        rows.push({ m: c.createdAt.slice(0, 7), n: Number(c.numberOfOrders) || 0, spent: Number(c.amountSpent.amount) || 0 });
      }
      if (done || !d.customers.pageInfo.hasNextPage) break; after = d.customers.pageInfo.endCursor;
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
  const months = {};
  for (const r of buyers) (months[r.m] || (months[r.m] = [])).push(r);
  const out = {};
  Object.keys(months).sort().forEach(m => { out[m] = calc(months[m]); });
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ since: STOP, pages, records_scanned: rows.length,
      all_buyers_since: calc(buyers), by_month: out }, null, 1) };
};
