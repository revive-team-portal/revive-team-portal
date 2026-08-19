// Read-only ad-vs-sales audit. ?k=..&start=YYYY-MM-DD&end=YYYY-MM-DD (NZ dates).
// Returns per-NZ-day Shopify orders/sales alongside Meta spend + funnel actions,
// campaign-level Meta detail for the range, and per-order attribution for the range.
// Writes nothing. Meta account tz (Etc/GMT+12) runs a day behind NZ, so the NZ->account
// date offset is derived live rather than assumed.
const { gql } = require('./_shopify');
const { metaAccountTz } = require('./_metasync');

const GUARD = process.env.PORTAL_RUN_KEY;
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

function pickActions(row) {
  const out = {};
  const want = { 'landing_page_view': 'lpv', 'add_to_cart': 'atc', 'omni_add_to_cart': 'atc_omni', 'initiate_checkout': 'ic', 'omni_initiated_checkout': 'ic_omni', 'purchase': 'purchases', 'omni_purchase': 'purchases_omni', 'offsite_conversion.fb_pixel_purchase': 'purchases_pixel', 'link_click': 'link_clicks' };
  for (const a of (row.actions || [])) if (want[a.action_type]) out[want[a.action_type]] = Number(a.value) || 0;
  for (const a of (row.action_values || [])) if (want[a.action_type]) out[want[a.action_type] + '_value'] = Number(a.value) || 0;
  return out;
}

async function metaGet(params) {
  if (!TOKEN) throw new Error('missing META_ACCESS_TOKEN');
  let url = GRAPH + '/' + ACCT + '/insights?' + params + '&limit=500&access_token=' + encodeURIComponent(TOKEN);
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

const FIELDS = 'spend,impressions,clicks,inline_link_clicks,ctr,cpc,reach,frequency,actions,action_values';

async function metaDaily(since, until) {
  const rows = await metaGet('level=account&fields=' + FIELDS + '&time_increment=1&time_range=' + encodeURIComponent(JSON.stringify({ since, until })));
  return rows.map(r => ({
    meta_date: r.date_start, spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0,
    clicks: Number(r.clicks) || 0, link_clicks: Number(r.inline_link_clicks) || 0, reach: Number(r.reach) || 0,
    ctr: Number(r.ctr) || 0, cpc: Number(r.cpc) || 0, ...pickActions(r),
  }));
}

async function metaCampaigns(since, until) {
  const rows = await metaGet('level=campaign&fields=campaign_name,' + FIELDS + '&time_range=' + encodeURIComponent(JSON.stringify({ since, until })));
  return rows.map(r => ({
    campaign: r.campaign_name, spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0,
    clicks: Number(r.clicks) || 0, link_clicks: Number(r.inline_link_clicks) || 0, ctr: Number(r.ctr) || 0, ...pickActions(r),
  })).sort((a, b) => b.spend - a.spend);
}

const ORDER_FIELDS = `
  name createdAt sourceName test
  currentTotalPriceSet{ shopMoney{ amount } }
  customer{ numberOfOrders }
  discountCodes
  landingPageUrl referrerUrl
  customerJourneySummary{ momentsCount{ count } daysToConversion customerOrderIndex
    firstVisit{ source sourceType referrerUrl landingPage utmParameters{ source medium campaign } }
    lastVisit{ source sourceType referrerUrl landingPage utmParameters{ source medium campaign } } }`;

async function shopifyOrders(startNz, endNz) {
  const q = 'created_at:>=' + startNz + 'T00:00:00+12:00 AND created_at:<' + shift(endNz, 1) + 'T00:00:00+12:00';
  const build = (f) => 'query($q:String!,$after:String){ orders(first:100, query:$q, after:$after, sortKey:CREATED_AT){ pageInfo{ hasNextPage endCursor } nodes{ ' + f + ' } } }';
  let fields = ORDER_FIELDS, journey = true;
  try { await gql(build(fields), { q, after: null }); }
  catch (e) { fields = ORDER_FIELDS.split('customerJourneySummary')[0]; journey = false; }
  const out = []; let after = null;
  for (let g = 0; g < 30; g++) {
    const r = await gql(build(fields), { q, after });
    const o = r && r.orders; if (!o) break;
    for (const n of o.nodes) {
      const j = n.customerJourneySummary || {};
      const lv = j.lastVisit || {}, fv = j.firstVisit || {};
      out.push({
        name: n.name, createdAt: n.createdAt, nz_date: NZ.format(new Date(n.createdAt)),
        amount: Number((n.currentTotalPriceSet && n.currentTotalPriceSet.shopMoney && n.currentTotalPriceSet.shopMoney.amount) || 0),
        channel: n.sourceName, test: !!n.test, landing: n.landingPageUrl || null, referrer: n.referrerUrl || null,
        customer_orders: n.customer ? n.customer.numberOfOrders : null,
        codes: n.discountCodes || [], order_index: j.customerOrderIndex == null ? null : j.customerOrderIndex,
        moments: (j.momentsCount && j.momentsCount.count != null) ? j.momentsCount.count : null,
        days_to_conv: j.daysToConversion == null ? null : j.daysToConversion,
        last_source: lv.source || null, last_type: lv.sourceType || null, last_ref: lv.referrerUrl || null,
        last_landing: lv.landingPage || null,
        last_utm: lv.utmParameters ? [lv.utmParameters.source, lv.utmParameters.medium, lv.utmParameters.campaign].filter(Boolean).join('|') : null,
        first_source: fv.source || null, first_type: fv.sourceType || null,
        first_utm: fv.utmParameters ? [fv.utmParameters.source, fv.utmParameters.medium, fv.utmParameters.campaign].filter(Boolean).join('|') : null,
      });
    }
    if (!o.pageInfo.hasNextPage) break; after = o.pageInfo.endCursor;
  }
  return { orders: out, journey };
}

exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  const end = qp.end || NZ.format(new Date());
  const start = qp.start || shift(end, -13);
  try {
    const off = await nzToMetaOffset();
    const mStart = shift(start, off.days), mEnd = shift(end, off.days);
    const [daily, camps, sh] = await Promise.all([
      metaDaily(mStart, mEnd).catch(e => ({ error: String(e.message || e) })),
      metaCampaigns(shift(end, off.days), shift(end, off.days)).catch(e => ({ error: String(e.message || e) })),
      shopifyOrders(start, end),
    ]);
    const byDay = {};
    for (const o of sh.orders) { const d = byDay[o.nz_date] || (byDay[o.nz_date] = { nz_date: o.nz_date, orders: 0, sales: 0 }); d.orders++; d.sales += o.amount; }
    const metaByNz = {};
    if (Array.isArray(daily)) for (const r of daily) metaByNz[shift(r.meta_date, -off.days)] = r;
    const days = Object.keys(byDay).sort().map(d => ({ ...byDay[d], sales: Math.round(byDay[d].sales * 100) / 100, meta: metaByNz[d] || null }));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true, nz_range: [start, end], meta_range: [mStart, mEnd], meta_tz: off.tz, nz_to_meta_offset_days: off.days,
        journey_available: sh.journey, days, campaigns_last_day: camps, orders: sh.orders }) };
  } catch (e) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
