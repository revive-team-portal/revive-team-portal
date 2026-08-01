// Shopify -> Scorecard weekly online sales/orders via the Admin orders API
// (portal app scope). Sums each order's current total (incl tax/shipping, net of
// refunds) into NZ Sat–Fri weeks -> online_sales / online_orders (source='shopify').
// Buckets by NZ-local order date (DST-safe). Never clobbers a manual override.
const { gql } = require('./_shopify');
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;

async function appsDb(path, opts = {}) {
  const headers = { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'scoreboard', 'Content-Profile': 'scoreboard', ...(opts.headers || {}) };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const t = await res.text(); if (!res.ok) throw new Error('DB ' + res.status + ': ' + t.slice(0, 160));
  return t ? JSON.parse(t) : null;
}
function addDays(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function nzDate(iso) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); }
function weekEndFri(ymd) { const d = new Date(ymd + 'T00:00:00Z'); const add = (5 - d.getUTCDay() + 7) % 7; d.setUTCDate(d.getUTCDate() + add); return d.toISOString().slice(0, 10); }

const ORDERS_Q = `query($q:String!,$after:String){ orders(first:250, query:$q, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ createdAt currentTotalPriceSet{ shopMoney{ amount } } } } }`;

async function fetchOrders(startUTC, endUTC) {
  let after = null, all = [];
  for (let guard = 0; guard < 400; guard++) {
    const d = await gql(ORDERS_Q, { q: `created_at:>='${startUTC}' created_at:<='${endUTC}'`, after });
    const o = d && d.orders; if (!o) break;
    all.push(...o.nodes);
    if (!o.pageInfo.hasNextPage) break;
    after = o.pageInfo.endCursor;
  }
  return all;
}

async function syncShopify(start, end) {
  const startUTC = addDays(start, -1) + 'T00:00:00Z';
  const endUTC = addDays(end, 1) + 'T00:00:00Z';
  const orders = await fetchOrders(startUTC, endUTC);

  const wk = {};
  for (const o of orders) {
    const we = weekEndFri(nzDate(o.createdAt));
    if (we < start || we > end) continue;
    const b = wk[we] || (wk[we] = { sales: 0, orders: 0 });
    b.sales += Number((o.currentTotalPriceSet && o.currentTotalPriceSet.shopMoney && o.currentTotalPriceSet.shopMoney.amount) || 0);
    b.orders += 1;
  }
  const weekRows = await appsDb('week?select=period_end');
  const exist = new Set((weekRows || []).map(x => x.period_end));
  const today = new Date().toISOString().slice(0, 10);
  const ov = await appsDb("fact?select=period_end,metric_code&period_type=eq.week&is_override=eq.true&metric_code=in.(online_sales,online_orders)");
  const ovSet = new Set((ov || []).map(r => r.metric_code + '|' + r.period_end));

  const rows = []; const written = [];
  for (const we of Object.keys(wk)) {
    if (!exist.has(we) || we > today) continue;
    const now = new Date().toISOString();
    if (!ovSet.has('online_sales|' + we)) rows.push({ metric_code: 'online_sales', period_type: 'week', period_end: we, value: Math.round(wk[we].sales * 100) / 100, source: 'shopify', quality: 'ok', entered_at: now });
    if (!ovSet.has('online_orders|' + we)) rows.push({ metric_code: 'online_orders', period_type: 'week', period_end: we, value: wk[we].orders, source: 'shopify', quality: 'ok', entered_at: now });
    written.push(we);
  }
  for (let i = 0; i < rows.length; i += 400) await appsDb('fact?on_conflict=metric_code,period_type,period_end', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 400)) });
  await appsDb("integration?name=eq.Shopify", { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_success: new Date().toISOString(), last_error: null, note: 'sync ' + new Date().toISOString() + ' weeks=' + written.length }) }).catch(() => {});
  return { orders: orders.length, weeks: written.length, sample: wk[weekEndFri(nzDate(endUTC))] };
}
module.exports = { syncShopify };
