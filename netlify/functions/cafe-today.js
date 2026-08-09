const { TODAY_SQL, queueJob, db } = require('./_posqueries');
const { gql } = require('./_shopify');
const { rest } = require('./_appsdb');
const { spendRange, metaAccountTz } = require('./_metasync');
const NZ = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });
function nzToday() { return NZ.format(new Date()); }
function nzToday_() { return NZ.format(new Date()); }

async function orderCounts() {
  try {
    const t = nzToday();
    const d = await gql('{ a: ordersCount(query:"fulfillment_status:unfulfilled status:open"){ count } b: ordersCount(query:"fulfillment_status:fulfilled updated_at:>=' + t + '"){ count } }');
    return { orders_to_fulfil: d && d.a ? d.a.count : null, orders_fulfilled_today: d && d.b ? d.b.count : null };
  } catch (e) { return { orders_to_fulfil: null, orders_fulfilled_today: null }; }
}
function todayAndWeekStart() {
  const today = nzToday();
  const d = new Date(today + 'T00:00:00Z'); const back = (d.getUTCDay() - 6 + 7) % 7; d.setUTCDate(d.getUTCDate() - back);
  return { today, weekStart: d.toISOString().slice(0, 10) };
}
async function metaSpend() {
  try {
    // Anchor the Sat-Fri week to NZ (the business calendar), then map to the ad
    // account's own calendar for the Meta query. The account tz (Etc/GMT+12 = UTC-12)
    // runs a full day behind NZ, so its dates are offset — derive that offset live
    // rather than assuming, then shift the NZ dates onto the account's dates.
    const tz = await metaAccountTz();
    const acctFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const now = new Date();
    const nzToday = nzToday_();                 // NZ calendar date
    const acctToday = acctFmt.format(now);      // ad-account calendar date (== NZ today's 24h window)
    const d = new Date(nzToday + 'T00:00:00Z'); const back = (d.getUTCDay() - 6 + 7) % 7; d.setUTCDate(d.getUTCDate() - back);
    const nzWeekStart = d.toISOString().slice(0, 10);   // most recent NZ Saturday
    const dayDiff = Math.round((Date.parse(acctToday + 'T00:00:00Z') - Date.parse(nzToday + 'T00:00:00Z')) / 86400000);
    const shift = (ymd, n) => { const x = new Date(ymd + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const acctWeekStart = shift(nzWeekStart, dayDiff);
    const [t, w] = await Promise.all([spendRange(acctToday, acctToday), spendRange(acctWeekStart, acctToday)]);
    return { meta_today: Math.round(t * 100) / 100, meta_week: Math.round(w * 100) / 100 };
  } catch (e) { return { meta_today: null, meta_week: null }; }
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
    const [rows, oc, ss, tk, ms] = await Promise.all([db('pos_today?id=eq.1&select=sales,covers,updated_at'), orderCounts(), shopifySums(), outstandingTickets(), metaSpend()]);
    const pct = (spend, sales) => (spend != null && sales != null && sales > 0) ? Math.round(spend / sales * 100) : null;
    const t = (rows && rows[0]) || {};
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ sales: t.sales, covers: t.covers, updated_at: t.updated_at,
        shopify_today: ss.shopify_today, shopify_week: ss.shopify_week,
        orders_to_fulfil: oc.orders_to_fulfil, orders_fulfilled_today: oc.orders_fulfilled_today, outstanding_tickets: tk.outstanding_tickets,
        meta_today: ms.meta_today, meta_week: ms.meta_week, meta_today_pct: pct(ms.meta_today, ss.shopify_today), meta_week_pct: pct(ms.meta_week, ss.shopify_week) }) };
  } catch (e) { return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(e.message || e) }) }; }
};
