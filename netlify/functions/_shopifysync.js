// Shopify -> Scorecard weekly online sales/orders. Uses ShopifyQL total_sales & orders
// (the exact figures the store's analytics show), bucketed into NZ Sat–Fri weeks,
// upserted as online_sales / online_orders facts (source='shopify'). Never clobbers
// a manual override.
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
function weekEndFri(ymd) { const d = new Date(ymd + 'T00:00:00Z'); const add = (5 - d.getUTCDay() + 7) % 7; d.setUTCDate(d.getUTCDate() + add); return d.toISOString().slice(0, 10); }

async function shopifyDaily(start, end) {
  const q = `FROM sales SHOW total_sales, orders TIMESERIES day SINCE ${start} UNTIL ${end}`;
  const data = await gql('query($q:String!){ shopifyqlQuery(query:$q){ tableData { rows } parseErrors } }', { q });
  const r = data && data.shopifyqlQuery;
  if (r && r.parseErrors && r.parseErrors.length) throw new Error('ShopifyQL: ' + JSON.stringify(r.parseErrors).slice(0, 120));
  return (r && r.tableData && r.tableData.rows) || [];
}

// start/end are YYYY-MM-DD. Returns summary of weeks written.
async function syncShopify(start, end) {
  // fetch in <=300-day chunks in parallel
  const chunks = [];
  for (let cs = start; cs <= end; cs = addDays(cs, 301)) chunks.push([cs, (addDays(cs, 300) < end ? addDays(cs, 300) : end)]);
  const dayRows = (await Promise.all(chunks.map(([a, b]) => shopifyDaily(a, b)))).flat();

  const wk = {}; // week_end -> {sales, orders}
  for (const row of dayRows) {
    const we = weekEndFri(row.day);
    const b = wk[we] || (wk[we] = { sales: 0, orders: 0 });
    b.sales += Number(row.total_sales || 0); b.orders += Number(row.orders || 0);
  }
  const weekRows = await appsDb('week?select=period_end');
  const exist = new Set((weekRows || []).map(x => x.period_end));
  const today = new Date().toISOString().slice(0, 10);

  // preserve manual overrides
  const ov = await appsDb("fact?select=period_end,metric_code&period_type=eq.week&is_override=eq.true&metric_code=in.(online_sales,online_orders)");
  const ovSet = new Set((ov || []).map(r => r.metric_code + '|' + r.period_end));

  const rows = [];
  const weeksWritten = [];
  for (const we of Object.keys(wk)) {
    if (!exist.has(we) || we > today) continue;
    const now = new Date().toISOString();
    if (!ovSet.has('online_sales|' + we)) rows.push({ metric_code: 'online_sales', period_type: 'week', period_end: we, value: Math.round(wk[we].sales * 100) / 100, source: 'shopify', quality: 'ok', entered_at: now });
    if (!ovSet.has('online_orders|' + we)) rows.push({ metric_code: 'online_orders', period_type: 'week', period_end: we, value: wk[we].orders, source: 'shopify', quality: 'ok', entered_at: now });
    weeksWritten.push(we);
  }
  // upsert in batches of 400
  for (let i = 0; i < rows.length; i += 400) {
    await appsDb('fact?on_conflict=metric_code,period_type,period_end', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 400)) });
  }
  await appsDb("integration?name=eq.Shopify", { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_success: new Date().toISOString(), last_error: null, note: 'sync ' + new Date().toISOString() + ' weeks=' + weeksWritten.length + ' range ' + start + '..' + end }) }).catch(() => {});
  return { weeks: weeksWritten.length, facts: rows.length, first: weeksWritten.sort()[0], last: weeksWritten.sort().slice(-1)[0] };
}
module.exports = { syncShopify };
