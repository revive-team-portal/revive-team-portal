// TEMPORARY per-order attribution audit. ?k=<guard>&start=YYYY-MM-DD&end=YYYY-MM-DD (NZ).
// Aggregates Shopify orders by customer-journey UTM / source, split by whether the
// order contains a Heat & Eat Meal and whether the customer was new. Delete when done.
const { gql } = require('./_shopify');
const GUARD = '54e584d50fb4cbf90f6c0fb88e0d8e72';
const shift = (y, n) => { const d = new Date(y + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const Q = `query($q:String!,$after:String){ orders(first:100, query:$q, after:$after, sortKey:CREATED_AT){
  pageInfo{ hasNextPage endCursor }
  nodes{ name createdAt test currentTotalPriceSet{ shopMoney{ amount } }
    customer{ numberOfOrders }
    lineItems(first:50){ nodes{ product{ productType } } }
    customerJourneySummary{ daysToConversion momentsCount{ count }
      firstVisit{ source sourceType landingPage referrerUrl utmParameters{ source medium campaign } }
      lastVisit{ source sourceType landingPage referrerUrl utmParameters{ source medium campaign } } } } } }`;

const key = (v) => {
  if (!v) return 'unknown';
  const u = v.utmParameters || {};
  if (u.source) return (u.source + ' / ' + (u.medium || '-')).toLowerCase();
  if (v.source) return (v.source + ' / ' + (v.sourceType || '-')).toLowerCase();
  return 'direct/none';
};

exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  const start = qp.start, end = qp.end;
  const q = 'created_at:>=' + start + 'T00:00:00+12:00 AND created_at:<' + shift(end, 1) + 'T00:00:00+12:00';
  const orders = [];
  let after = null;
  try {
    for (let i = 0; i < 15; i++) {
      const d = await gql(Q, { q, after });
      const o = d.orders; o.nodes.forEach(n => orders.push(n));
      if (!o.pageInfo.hasNextPage) break; after = o.pageInfo.endCursor;
    }
  } catch (e) { return { statusCode: 200, body: JSON.stringify({ error: String(e.message || e) }) }; }

  const agg = {};
  let meals = 0, mealsNew = 0, total = 0, journeyMissing = 0;
  const clickIds = { gclid: 0, gbraid: 0, wbraid: 0, fbclid: 0, srsltid: 0, utm_google_cpc: 0, none: 0 };
  for (const o of orders) {
    if (o.test) continue;
    total++;
    const isMeal = (o.lineItems.nodes || []).some(l => l.product && l.product.productType === 'Heat & Eat Meals');
    const isNew = !o.customer || (o.customer.numberOfOrders != null && Number(o.customer.numberOfOrders) <= 1);
    const j = o.customerJourneySummary;
    if (!j) journeyMissing++;
    const last = key(j && j.lastVisit), first = key(j && j.firstVisit);
    if (isMeal) { meals++; if (isNew) mealsNew++; }
    const bump = (bucket, k) => {
      const m = agg[bucket] || (agg[bucket] = {});
      const r = m[k] || (m[k] = { orders: 0, meals: 0, meals_new: 0, revenue: 0 });
      r.orders++; r.revenue += Number(o.currentTotalPriceSet.shopMoney.amount) || 0;
      if (isMeal) { r.meals++; if (isNew) r.meals_new++; }
    };
    const urls = [j && j.firstVisit && j.firstVisit.landingPage, j && j.lastVisit && j.lastVisit.landingPage].filter(Boolean).join(' ');
    let hit = false;
    for (const id of ['gclid', 'gbraid', 'wbraid', 'fbclid', 'srsltid']) if (urls.indexOf(id + '=') >= 0) { clickIds[id]++; hit = true; }
    const um = (j && j.lastVisit && j.lastVisit.utmParameters) || {};
    if ((um.source || '').toLowerCase() === 'google' && ['cpc', 'ppc', 'paid'].indexOf((um.medium || '').toLowerCase()) >= 0) { clickIds.utm_google_cpc++; hit = true; }
    if (!hit) clickIds.none++;
    bump('last_touch', last); bump('first_touch', first);
  }
  const srt = (m) => Object.entries(m).sort((a, b) => b[1].orders - a[1].orders)
    .map(([k, v]) => ({ src: k, ...v, revenue: Math.round(v.revenue) }));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ range: [start, end], total_orders: total, meals_orders: meals, meals_new_customers: mealsNew,
      journey_missing: journeyMissing, click_ids: clickIds, last_touch: srt(agg.last_touch || {}), first_touch: srt(agg.first_touch || {}) }, null, 1) };
};
