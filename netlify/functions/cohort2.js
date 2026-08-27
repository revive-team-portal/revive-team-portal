// TEMPORARY cohort LTV audit. ?k=<guard>&start=YYYY-MM-DD&end=YYYY-MM-DD
// For customers whose FIRST order fell in the window, reports repeat rate and
// cumulative spend to date, split by whether that first order contained meals.
const { gql } = require('./_shopify');
const GUARD = '96ea0c608768a18f95b9e0e36be9d724';
const Q = `query($q:String!,$after:String){ orders(first:100, query:$q, after:$after, sortKey:CREATED_AT){
  pageInfo{ hasNextPage endCursor }
  nodes{ createdAt test
    customer{ id numberOfOrders amountSpent{ amount } createdAt }
    lineItems(first:50){ nodes{ product{ productType } } } } } }`;

exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  const q = 'created_at:>=' + qp.start + 'T00:00:00+12:00 AND created_at:<' + qp.end + 'T00:00:00+12:00';
  const seen = new Map();
  let after = null;
  try {
    for (let i = 0; i < 20; i++) {
      const d = await gql(Q, { q, after });
      for (const o of d.orders.nodes) {
        if (o.test || !o.customer) continue;
        // first-time buyer at the moment of this order: customer record created in-window
        const cAt = o.customer.createdAt || '';
        if (cAt < qp.start) continue;
        const isMeal = (o.lineItems.nodes || []).some(l => l.product && l.product.productType === 'Heat & Eat Meals');
        const prev = seen.get(o.customer.id);
        if (!prev) seen.set(o.customer.id, { meals: isMeal, n: Number(o.customer.numberOfOrders) || 0, spent: Number(o.customer.amountSpent.amount) || 0 });
        else if (isMeal) prev.meals = true;
      }
      if (!d.orders.pageInfo.hasNextPage) break; after = d.orders.pageInfo.endCursor;
    }
  } catch (e) { return { statusCode: 200, body: JSON.stringify({ error: String(e.message || e) }) }; }

  const calc = (list) => {
    if (!list.length) return null;
    const n = list.length;
    const repeat = list.filter(c => c.n > 1).length;
    const orders = list.reduce((a, c) => a + c.n, 0);
    const spend = list.reduce((a, c) => a + c.spent, 0);
    return { customers: n, repeat_customers: repeat, repeat_rate: +(repeat / n * 100).toFixed(1),
      avg_orders: +(orders / n).toFixed(2), avg_lifetime_spend: +(spend / n).toFixed(2),
      total_spend: Math.round(spend) };
  };
  const all = [...seen.values()];
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cohort: [qp.start, qp.end], all: calc(all),
      meals_first_order: calc(all.filter(c => c.meals)), non_meals: calc(all.filter(c => !c.meals)) }, null, 1) };
};
