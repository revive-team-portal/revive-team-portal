// TEMPORARY read-only ads review endpoint. Deleted immediately after use.
const { gql } = require('./_shopify');
const { metaAccountTz } = require('./_metasync');

const GUARD = 'rv9Qk2mTx7Lp4wZa';
const GRAPH = 'https://graph.facebook.com/v21.0';
const TOKEN = process.env.META_ACCESS_TOKEN;
const ACCT = process.env.META_AD_ACCOUNT || 'act_242089740673955';
const NZ = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });
const shift = (ymd, n) => { const x = new Date(ymd + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function nzToMetaOffset() {
  const tz = await metaAccountTz();
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const now = new Date();
  return { tz, days: Math.round((Date.parse(f.format(now) + 'T00:00:00Z') - Date.parse(NZ.format(now) + 'T00:00:00Z')) / 86400000) };
}

const WINDOWS = ['1d_click', '7d_click', '1d_view'];
function purch(row) {
  const out = { p_1dc: 0, p_7dc: 0, p_1dv: 0, v_1dc: 0, v_7dc: 0, v_1dv: 0, p_default: 0, v_default: 0 };
  const isP = t => t === 'omni_purchase' || t === 'purchase' || t === 'offsite_conversion.fb_pixel_purchase';
  const pick = (arr) => (arr || []).find(a => a.action_type === 'omni_purchase') || (arr || []).find(a => a.action_type === 'purchase') || (arr || []).find(a => isP(a.action_type));
  const a = pick(row.actions), v = pick(row.action_values);
  if (a) { out.p_1dc = Number(a['1d_click'] || 0); out.p_7dc = Number(a['7d_click'] || 0); out.p_1dv = Number(a['1d_view'] || 0); out.p_default = Number(a.value || 0); }
  if (v) { out.v_1dc = Number(v['1d_click'] || 0); out.v_7dc = Number(v['7d_click'] || 0); out.v_1dv = Number(v['1d_view'] || 0); out.v_default = Number(v.value || 0); }
  return out;
}
function funnel(row) {
  const o = {};
  const want = { landing_page_view: 'lpv', add_to_cart: 'atc', omni_add_to_cart: 'atc_omni', initiate_checkout: 'ic', omni_initiated_checkout: 'ic_omni', link_click: 'link_clicks_a', post_engagement: 'post_eng' };
  for (const a of (row.actions || [])) if (want[a.action_type]) o[want[a.action_type]] = Number(a.value) || 0;
  return o;
}

async function metaGet(params) {
  if (!TOKEN) throw new Error('missing META_ACCESS_TOKEN');
  let url = GRAPH + '/' + ACCT + '/insights?' + params
    + '&use_unified_attribution_setting=false'
    + '&action_attribution_windows=' + encodeURIComponent(JSON.stringify(WINDOWS))
    + '&limit=500&access_token=' + encodeURIComponent(TOKEN);
  const all = [];
  for (let g = 0; g < 50 && url; g++) {
    const res = await fetch(url);
    const j = await res.json().catch(() => ({}));
    if (j.error) throw new Error('Meta ' + String(j.error.message || JSON.stringify(j.error)).slice(0, 200));
    (j.data || []).forEach(d => all.push(d));
    url = (j.paging && j.paging.next) ? j.paging.next : null;
  }
  return all;
}
const FIELDS = 'spend,impressions,clicks,inline_link_clicks,ctr,cpc,cpm,reach,frequency,actions,action_values';
const base = r => ({ spend: Number(r.spend) || 0, impr: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0,
  link_clicks: Number(r.inline_link_clicks) || 0, reach: Number(r.reach) || 0, freq: Number(r.frequency) || 0,
  ctr: Number(r.ctr) || 0, cpc: Number(r.cpc) || 0, cpm: Number(r.cpm) || 0, ...funnel(r), ...purch(r) });

async function graph(path, fields, extra) {
  let url = GRAPH + '/' + path + '?fields=' + encodeURIComponent(fields) + (extra || '') + '&limit=200&access_token=' + encodeURIComponent(TOKEN);
  const all = [];
  for (let i = 0; i < 20 && url; i++) {
    const r = await fetch(url); const j = await r.json().catch(() => ({}));
    if (j.error) throw new Error('Meta ' + String(j.error.message || '').slice(0, 200));
    if (!j.data) return j;
    j.data.forEach(x => all.push(x));
    url = (j.paging && j.paging.next) ? j.paging.next : null;
  }
  return all;
}
const money = v => v == null ? null : Math.round(Number(v)) / 100;

const ORDER_FIELDS = `
  name createdAt sourceName test
  currentTotalPriceSet{ shopMoney{ amount } }
  customer{ numberOfOrders }
  customerJourneySummary{ daysToConversion customerOrderIndex
    firstVisit{ source sourceType utmParameters{ source medium campaign } }
    lastVisit{ source sourceType utmParameters{ source medium campaign } } }`;
async function shopifyOrders(startNz, endNz) {
  const q = 'created_at:>=' + startNz + 'T00:00:00+12:00 AND created_at:<' + shift(endNz, 1) + 'T00:00:00+12:00';
  const build = f => 'query($q:String!,$after:String){ orders(first:100, query:$q, after:$after, sortKey:CREATED_AT){ pageInfo{ hasNextPage endCursor } nodes{ ' + f + ' } } }';
  const out = []; let after = null;
  for (let g = 0; g < 30; g++) {
    const r = await gql(build(ORDER_FIELDS), { q, after });
    const o = r && r.orders; if (!o) break;
    for (const n of o.nodes) {
      const j = n.customerJourneySummary || {}; const lv = j.lastVisit || {}, fv = j.firstVisit || {};
      out.push({ name: n.name, nz_date: NZ.format(new Date(n.createdAt)),
        amount: Number((n.currentTotalPriceSet && n.currentTotalPriceSet.shopMoney && n.currentTotalPriceSet.shopMoney.amount) || 0),
        channel: n.sourceName, test: !!n.test, cust_orders: n.customer ? n.customer.numberOfOrders : null,
        order_index: j.customerOrderIndex == null ? null : j.customerOrderIndex,
        days_to_conv: j.daysToConversion == null ? null : j.daysToConversion,
        last_source: lv.source || null, last_type: lv.sourceType || null,
        last_utm: lv.utmParameters ? [lv.utmParameters.source, lv.utmParameters.medium, lv.utmParameters.campaign].filter(Boolean).join('|') : null,
        first_source: fv.source || null, first_type: fv.sourceType || null,
        first_utm: fv.utmParameters ? [fv.utmParameters.source, fv.utmParameters.medium, fv.utmParameters.campaign].filter(Boolean).join('|') : null });
    }
    if (!o.pageInfo.hasNextPage) break; after = o.pageInfo.endCursor;
  }
  return out;
}

exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  const end = qp.end || NZ.format(new Date());
  const start = qp.start || shift(end, -20);
  try {
    const off = await nzToMetaOffset();
    const mStart = shift(start, off.days), mEnd = shift(end, off.days);
    const TR = encodeURIComponent(JSON.stringify({ since: mStart, until: mEnd }));
    const wkStart = shift(qp.wkstart || shift(end, -7), off.days), wkEnd = shift(qp.wkend || shift(end, -1), off.days);
    const WK = encodeURIComponent(JSON.stringify({ since: wkStart, until: wkEnd }));
    const [daily, adsetDaily, adsetWk, adWk, acct, camps, sets, orders] = await Promise.all([
      metaGet('level=account&fields=' + FIELDS + '&time_increment=1&time_range=' + TR).catch(e => ({ error: String(e.message || e) })),
      metaGet('level=adset&fields=adset_name,campaign_name,' + FIELDS + '&time_increment=1&time_range=' + WK).catch(e => ({ error: String(e.message || e) })),
      metaGet('level=adset&fields=adset_name,campaign_name,' + FIELDS + '&time_range=' + WK).catch(e => ({ error: String(e.message || e) })),
      metaGet('level=ad&fields=ad_name,adset_name,campaign_name,' + FIELDS + '&time_range=' + WK).catch(e => ({ error: String(e.message || e) })),
      graph(ACCT, 'name,currency,timezone_name,spend_cap,amount_spent,balance,account_status,disable_reason,min_daily_budget').catch(e => ({ error: String(e.message || e) })),
      graph(ACCT + '/campaigns', 'name,status,effective_status,objective,bid_strategy,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time', '&effective_status=' + encodeURIComponent(JSON.stringify(['ACTIVE', 'PAUSED']))).catch(e => ({ error: String(e.message || e) })),
      graph(ACCT + '/adsets', 'name,status,effective_status,campaign_id,daily_budget,lifetime_budget,budget_remaining,bid_strategy,bid_amount,billing_event,optimization_goal,pacing_type,start_time,end_time,adset_schedule,attribution_spec', '&effective_status=' + encodeURIComponent(JSON.stringify(['ACTIVE', 'PAUSED']))).catch(e => ({ error: String(e.message || e) })),
      shopifyOrders(start, end).catch(e => ({ error: String(e.message || e) })),
    ]);
    const map = r => ({ meta_date: r.date_start, nz_date: shift(r.date_start, -off.days), ...base(r) });
    const named = r => ({ nz_date: r.date_start ? shift(r.date_start, -off.days) : null, campaign: r.campaign_name, adset: r.adset_name, ad: r.ad_name, ...base(r) });
    const byDay = {};
    if (Array.isArray(orders)) for (const o of orders) { const d = byDay[o.nz_date] || (byDay[o.nz_date] = { nz_date: o.nz_date, orders: 0, sales: 0 }); d.orders++; d.sales += o.amount; }
    const clean = x => ({ ...x, daily_budget: money(x.daily_budget), lifetime_budget: money(x.lifetime_budget), budget_remaining: money(x.budget_remaining) });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true, nz_range: [start, end], wk_meta_range: [wkStart, wkEnd], meta_tz: off.tz, offset: off.days,
        account: acct.error ? acct : { ...acct, spend_cap: money(acct.spend_cap), amount_spent: money(acct.amount_spent), balance: money(acct.balance) },
        campaigns: Array.isArray(camps) ? camps.map(clean) : camps,
        adsets: Array.isArray(sets) ? sets.map(clean) : sets,
        daily: Array.isArray(daily) ? daily.map(map) : daily,
        adset_daily: Array.isArray(adsetDaily) ? adsetDaily.map(named) : adsetDaily,
        adset_week: Array.isArray(adsetWk) ? adsetWk.map(named) : adsetWk,
        ad_week: Array.isArray(adWk) ? adWk.map(named) : adWk,
        shopify_by_day: Object.keys(byDay).sort().map(d => ({ ...byDay[d], sales: Math.round(byDay[d].sales * 100) / 100 })),
        orders: Array.isArray(orders) ? orders : orders }, null, 1) };
  } catch (e) { return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(e.message || e) }) }; }
};
