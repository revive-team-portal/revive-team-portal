// TEMPORARY read-only history reporter. ?k=<runkey>&start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns Shopify online sales/orders bucketed into NZ Sat-Fri weeks. No DB writes.
const { gql } = require('./_shopify');
const { guard } = require('./_runkey');
function addDays(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function nzDate(iso) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); }
function weekEndFri(ymd) { const d = new Date(ymd + 'T00:00:00Z'); const add = (5 - d.getUTCDay() + 7) % 7; d.setUTCDate(d.getUTCDate() + add); return d.toISOString().slice(0, 10); }
const ORDERS_Q = `query($q:String!,$after:String){ orders(first:250, query:$q, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ createdAt currentTotalPriceSet{ shopMoney{ amount } } } } }`;
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (!(await guard(event)).ok) return { statusCode: 403, body: 'nope' };
  const start = qp.start || '2026-05-30', end = qp.end || '2026-07-31';
  const startUTC = addDays(start, -1) + 'T00:00:00Z', endUTC = addDays(end, 1) + 'T00:00:00Z';
  let after = null, all = [];
  try {
    for (let g = 0; g < 400; g++) {
      const d = await gql(ORDERS_Q, { q: `created_at:>='${startUTC}' created_at:<='${endUTC}'`, after });
      const o = d && d.orders; if (!o) break; all.push(...o.nodes);
      if (!o.pageInfo.hasNextPage) break; after = o.pageInfo.endCursor;
    }
  } catch (e) { return { statusCode: 500, body: String(e.message || e) }; }
  const wk = {};
  for (const o of all) {
    const we = weekEndFri(nzDate(o.createdAt));
    if (we < start || we > end) continue;
    const b = wk[we] || (wk[we] = { sales: 0, orders: 0 });
    b.sales += Number((o.currentTotalPriceSet && o.currentTotalPriceSet.shopMoney && o.currentTotalPriceSet.shopMoney.amount) || 0);
    b.orders += 1;
  }
  const weeks = Object.keys(wk).sort().map(we => ({ week_end: we, sales: Math.round(wk[we].sales * 100) / 100, orders: wk[we].orders }));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ ok: true, total_orders: all.length, weeks }, null, 1) };
};
