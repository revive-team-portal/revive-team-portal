const { TODAY_SQL, YESTERDAY_SQL, WEEK_TD_SQL, queueJob, db } = require('./_posqueries');
const { gql } = require('./_shopify');
const { rest } = require('./_appsdb');
const { spendRange, metaInsightsRange, metaAccountTz } = require('./_metasync');
const NZ = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });
function nzToday() { return NZ.format(new Date()); }
function nzToday_() { return NZ.format(new Date()); }
function nzYesterdayStr() { const d = new Date(nzToday() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }
function nzOffMin() { try { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Pacific/Auckland', timeZoneName: 'shortOffset' }).formatToParts(new Date()).find(x => x.type === 'timeZoneName').value; const m = /GMT([+-]\d+)/.exec(p || ''); return m ? parseInt(m[1], 10) * 60 : 720; } catch (e) { return 720; } }

async function orderCounts() {
  try {
    const { today, weekStart } = todayAndWeekStart();
    const y = nzYesterdayStr();
    const d = await gql('{ a: ordersCount(query:"fulfillment_status:unfulfilled status:open"){ count } b: ordersCount(query:"fulfillment_status:fulfilled updated_at:>=' + today + '"){ count } c: ordersCount(query:"fulfillment_status:fulfilled updated_at:>=' + y + ' updated_at:<' + today + '"){ count } e: ordersCount(query:"fulfillment_status:fulfilled updated_at:>=' + weekStart + '"){ count } }');
    return { orders_to_fulfil: d && d.a ? d.a.count : null, orders_fulfilled_today: d && d.b ? d.b.count : null, orders_fulfilled_yest: d && d.c ? d.c.count : null, orders_fulfilled_week: d && d.e ? d.e.count : null };
  } catch (e) { return { orders_to_fulfil: null, orders_fulfilled_today: null, orders_fulfilled_yest: null, orders_fulfilled_week: null }; }
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
    const acctYest = shift(acctToday, -1);
    const [t, w, y] = await Promise.all([metaInsightsRange(acctToday, acctToday), metaInsightsRange(acctWeekStart, acctToday), metaInsightsRange(acctYest, acctYest)]);
    const meta_today = Math.round(t.spend * 100) / 100;
    const meta_week = Math.round(w.spend * 100) / 100;
    const meta_yest = Math.round((y.spend || 0) * 100) / 100;
    const acqT = Math.round(t.acq || 0), acqW = Math.round(w.acq || 0), acqY = Math.round(y.acq || 0);
    return { meta_today, meta_week, meta_yest, meta_acq_yest: acqY, meta_cpa_yest: acqY > 0 ? Math.round((meta_yest / acqY) * 100) / 100 : null,
      meta_acq_today: acqT, meta_cpa_today: acqT > 0 ? Math.round((meta_today / acqT) * 100) / 100 : null,
      meta_acq_week: acqW, meta_cpa_week: acqW > 0 ? Math.round((meta_week / acqW) * 100) / 100 : null };
  } catch (e) { return { meta_today: null, meta_week: null, meta_yest: null, meta_acq_yest: null, meta_cpa_yest: null, meta_acq_today: null, meta_cpa_today: null, meta_acq_week: null, meta_cpa_week: null }; }
}
async function shopifySums() {
  try {
    const today = nzToday();
    // start of current Sat–Fri week (most recent Saturday on/before today)
    const d = new Date(today + 'T00:00:00Z'); const back = (d.getUTCDay() - 6 + 7) % 7; d.setUTCDate(d.getUTCDate() - back);
    const weekStart = d.toISOString().slice(0, 10);
    const Q = 'query($q:String!,$after:String){ orders(first:250, query:$q, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ createdAt currentTotalPriceSet{ shopMoney{ amount } } } } }';
    const yest = nzYesterdayStr();
    const floor = yest < weekStart ? yest : weekStart;
    let after = null, weekSum = 0, todaySum = 0, weekCnt = 0, todayCnt = 0, yestSum = 0, yestCnt = 0;
    for (let g = 0; g < 20; g++) {
      const r = await gql(Q, { q: 'created_at:>=' + floor, after });
      const o = r && r.orders; if (!o) break;
      for (const n of o.nodes) {
        const amt = Number((n.currentTotalPriceSet && n.currentTotalPriceSet.shopMoney && n.currentTotalPriceSet.shopMoney.amount) || 0);
        const ds = NZ.format(new Date(n.createdAt));
        if (ds >= weekStart) { weekSum += amt; weekCnt++; }
        if (ds === today) { todaySum += amt; todayCnt++; }
        else if (ds === yest) { yestSum += amt; yestCnt++; }
      }
      if (!o.pageInfo.hasNextPage) break; after = o.pageInfo.endCursor;
    }
    return { shopify_today: Math.round(todaySum * 100) / 100, shopify_week: Math.round(weekSum * 100) / 100, shopify_yest: Math.round(yestSum * 100) / 100, shopify_today_orders: todayCnt, shopify_week_orders: weekCnt, shopify_yest_orders: yestCnt };
  } catch (e) { return { shopify_today: null, shopify_week: null, shopify_yest: null, shopify_today_orders: null, shopify_week_orders: null, shopify_yest_orders: null }; }
}
async function outstandingTickets() {
  try { const rows = await rest('tickets?status=neq.Resolved&select=id&limit=1000'); return { outstanding_tickets: Array.isArray(rows) ? rows.length : null }; }
  catch (e) { return { outstanding_tickets: null }; }
}
async function newJobApps() {
  const H = { 'Accept-Profile': 'jobs', 'Content-Profile': 'jobs' };
  const out = { new_job_apps: null, new_job_apps_yest: null, new_job_apps_week: null };
  try { const rows = await rest('applications?status=eq.new&select=id&limit=2000', { headers: H }); out.new_job_apps = Array.isArray(rows) ? rows.length : null; } catch (e) {}
  try {
    const { today, weekStart } = todayAndWeekStart();
    const y = nzYesterdayStr();
    const off = nzOffMin();
    const toUTC = (ymd) => new Date(Date.parse(ymd + 'T00:00:00Z') - off * 60000).toISOString();
    const [yr, wr] = await Promise.all([
      rest('applications?created_at=gte.' + encodeURIComponent(toUTC(y)) + '&created_at=lt.' + encodeURIComponent(toUTC(today)) + '&select=id&limit=5000', { headers: H }),
      rest('applications?created_at=gte.' + encodeURIComponent(toUTC(weekStart)) + '&select=id&limit=5000', { headers: H }),
    ]);
    out.new_job_apps_yest = Array.isArray(yr) ? yr.length : null;
    out.new_job_apps_week = Array.isArray(wr) ? wr.length : null;
  } catch (e) {}
  return out;
}
const RESP_H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
const send = (o) => ({ statusCode: 200, headers: RESP_H, body: JSON.stringify(o) });
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  const only = qp.only;
  try {
    // Per-source endpoints so the loading bar can tick each independently.
    if (only === 'pos') { if (qp.refresh) { await queueJob('cafe-today', TODAY_SQL).catch(() => {}); await queueJob('cafe-yesterday', YESTERDAY_SQL).catch(() => {}); await queueJob('cafe-week', WEEK_TD_SQL).catch(() => {}); } const rows = await db('pos_today?id=eq.1&select=sales,covers,sales_1245,updated_at,sales_y,covers_y,sales_w,covers_w'); const t = (rows && rows[0]) || {}; return send({ sales: t.sales, covers: t.covers, sales_1245: t.sales_1245, updated_at: t.updated_at, cafe_sales_y: t.sales_y, cafe_covers_y: t.covers_y, cafe_sales_w: t.sales_w, cafe_covers_w: t.covers_w }); }
    if (only === 'shopify') { const [ss, oc] = await Promise.all([shopifySums(), orderCounts()]); return send({ ...ss, ...oc }); }
    if (only === 'meta') { const ms = await metaSpend(); return send(ms); }
    if (only === 'support') { const tk = await outstandingTickets(); return send(tk); }
    if (only === 'jobs') { const jb = await newJobApps(); return send(jb); }
    if (qp.refresh) await queueJob('cafe-today', TODAY_SQL).catch(() => {});
    const [rows, oc, ss, tk, ms, jb] = await Promise.all([db('pos_today?id=eq.1&select=sales,covers,sales_1245,updated_at,sales_y,covers_y,sales_w,covers_w'), orderCounts(), shopifySums(), outstandingTickets(), metaSpend(), newJobApps()]);
    const pct = (spend, sales) => (spend != null && sales != null && sales > 0) ? Math.round(spend / sales * 100) : null;
    const t = (rows && rows[0]) || {};
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ sales: t.sales, covers: t.covers, sales_1245: t.sales_1245, updated_at: t.updated_at, cafe_sales_y: t.sales_y, cafe_covers_y: t.covers_y, cafe_sales_w: t.sales_w, cafe_covers_w: t.covers_w,
        shopify_today: ss.shopify_today, shopify_week: ss.shopify_week, shopify_yest: ss.shopify_yest, shopify_today_orders: ss.shopify_today_orders, shopify_week_orders: ss.shopify_week_orders, shopify_yest_orders: ss.shopify_yest_orders,
        orders_to_fulfil: oc.orders_to_fulfil, orders_fulfilled_today: oc.orders_fulfilled_today, orders_fulfilled_yest: oc.orders_fulfilled_yest, orders_fulfilled_week: oc.orders_fulfilled_week, outstanding_tickets: tk.outstanding_tickets, new_job_apps: jb.new_job_apps, new_job_apps_yest: jb.new_job_apps_yest, new_job_apps_week: jb.new_job_apps_week,
        meta_today: ms.meta_today, meta_week: ms.meta_week, meta_yest: ms.meta_yest, meta_acq_yest: ms.meta_acq_yest, meta_cpa_yest: ms.meta_cpa_yest, meta_acq_today: ms.meta_acq_today, meta_cpa_today: ms.meta_cpa_today, meta_acq_week: ms.meta_acq_week, meta_cpa_week: ms.meta_cpa_week, meta_today_pct: pct(ms.meta_today, ss.shopify_today), meta_week_pct: pct(ms.meta_week, ss.shopify_week) }) };
  } catch (e) { return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(e.message || e) }) }; }
};
