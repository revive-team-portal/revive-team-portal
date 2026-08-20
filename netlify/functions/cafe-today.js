const { TODAY_SQL, queueJob, db } = require('./_posqueries');
const { gql } = require('./_shopify');
const { rest } = require('./_appsdb');
const { spendRange, metaInsightsRange, metaAccountTz } = require('./_metasync');
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
    const [t, w] = await Promise.all([metaInsightsRange(acctToday, acctToday), metaInsightsRange(acctWeekStart, acctToday)]);
    const meta_today = Math.round(t.spend * 100) / 100;
    const meta_week = Math.round(w.spend * 100) / 100;
    const acqT = Math.round(t.acq || 0), acqW = Math.round(w.acq || 0);
    return { meta_today, meta_week,
      meta_acq_today: acqT, meta_cpa_today: acqT > 0 ? Math.round((meta_today / acqT) * 100) / 100 : null,
      meta_acq_week: acqW, meta_cpa_week: acqW > 0 ? Math.round((meta_week / acqW) * 100) / 100 : null };
  } catch (e) { return { meta_today: null, meta_week: null, meta_acq_today: null, meta_cpa_today: null, meta_acq_week: null, meta_cpa_week: null }; }
}
async function shopifySums() {
  try {
    const today = nzToday();
    // start of current Sat–Fri week (most recent Saturday on/before today)
    const d = new Date(today + 'T00:00:00Z'); const back = (d.getUTCDay() - 6 + 7) % 7; d.setUTCDate(d.getUTCDate() - back);
    const weekStart = d.toISOString().slice(0, 10);
    const Q = 'query($q:String!,$after:String){ orders(first:250, query:$q, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ createdAt currentTotalPriceSet{ shopMoney{ amount } } } } }';
    let after = null, weekSum = 0, todaySum = 0, weekCnt = 0, todayCnt = 0;
    for (let g = 0; g < 20; g++) {
      const r = await gql(Q, { q: 'created_at:>=' + weekStart, after });
      const o = r && r.orders; if (!o) break;
      for (const n of o.nodes) {
        const amt = Number((n.currentTotalPriceSet && n.currentTotalPriceSet.shopMoney && n.currentTotalPriceSet.shopMoney.amount) || 0);
        weekSum += amt; weekCnt++;
        if (NZ.format(new Date(n.createdAt)) === today) { todaySum += amt; todayCnt++; }
      }
      if (!o.pageInfo.hasNextPage) break; after = o.pageInfo.endCursor;
    }
    return { shopify_today: Math.round(todaySum * 100) / 100, shopify_week: Math.round(weekSum * 100) / 100, shopify_today_orders: todayCnt, shopify_week_orders: weekCnt };
  } catch (e) { return { shopify_today: null, shopify_week: null, shopify_today_orders: null, shopify_week_orders: null }; }
}
async function outstandingTickets() {
  try { const rows = await rest('tickets?status=neq.Resolved&select=id&limit=1000'); return { outstanding_tickets: Array.isArray(rows) ? rows.length : null }; }
  catch (e) { return { outstanding_tickets: null }; }
}
async function newJobApps() {
  // Applications still to be actioned: status 'new' drops off once shortlisted/interview/hired/not_suitable.
  try { const rows = await rest('applications?status=eq.new&select=id&limit=2000', { headers: { 'Accept-Profile': 'jobs', 'Content-Profile': 'jobs' } }); return { new_job_apps: Array.isArray(rows) ? rows.length : null }; }
  catch (e) { return { new_job_apps: null }; }
}
const RESP_H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
const send = (o) => ({ statusCode: 200, headers: RESP_H, body: JSON.stringify(o) });
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  const only = qp.only;
  try {
    // Per-source endpoints so the loading bar can tick each independently.
    if (only === 'pos') { if (qp.refresh) await queueJob('cafe-today', TODAY_SQL).catch(() => {}); const rows = await db('pos_today?id=eq.1&select=sales,covers,sales_1245,updated_at'); const t = (rows && rows[0]) || {}; return send({ sales: t.sales, covers: t.covers, sales_1245: t.sales_1245, updated_at: t.updated_at }); }
    if (only === 'shopify') { const [ss, oc] = await Promise.all([shopifySums(), orderCounts()]); return send({ ...ss, ...oc }); }
    if (only === 'meta') { const ms = await metaSpend(); return send(ms); }
    if (only === 'support') { const tk = await outstandingTickets(); return send(tk); }
    if (only === 'jobs') { const jb = await newJobApps(); return send(jb); }
    if (qp.refresh) await queueJob('cafe-today', TODAY_SQL).catch(() => {});
    const [rows, oc, ss, tk, ms, jb] = await Promise.all([db('pos_today?id=eq.1&select=sales,covers,sales_1245,updated_at'), orderCounts(), shopifySums(), outstandingTickets(), metaSpend(), newJobApps()]);
    const pct = (spend, sales) => (spend != null && sales != null && sales > 0) ? Math.round(spend / sales * 100) : null;
    const t = (rows && rows[0]) || {};
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ sales: t.sales, covers: t.covers, sales_1245: t.sales_1245, updated_at: t.updated_at,
        shopify_today: ss.shopify_today, shopify_week: ss.shopify_week, shopify_today_orders: ss.shopify_today_orders, shopify_week_orders: ss.shopify_week_orders,
        orders_to_fulfil: oc.orders_to_fulfil, orders_fulfilled_today: oc.orders_fulfilled_today, outstanding_tickets: tk.outstanding_tickets, new_job_apps: jb.new_job_apps,
        meta_today: ms.meta_today, meta_week: ms.meta_week, meta_acq_today: ms.meta_acq_today, meta_cpa_today: ms.meta_cpa_today, meta_acq_week: ms.meta_acq_week, meta_cpa_week: ms.meta_cpa_week, meta_today_pct: pct(ms.meta_today, ss.shopify_today), meta_week_pct: pct(ms.meta_week, ss.shopify_week) }) };
  } catch (e) { return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(e.message || e) }) }; }
};
