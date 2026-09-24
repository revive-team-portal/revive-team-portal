// Data for the daily Meta ads email: yesterday (NZ) at ad level, split by
// attribution window, with 7-day context, plus Shopify orders for the same NZ
// day with journey/attribution and discount codes. Read-only.
const { gql } = require('./_shopify');
const { graph, pageAll, shapePerf, nzToMetaOffsetDays, INSIGHT_FIELDS, ATTR, ACCT, NZ, shift } = require('./_adsmeta');

async function adInsights(since, until, inc) {
  const qs = 'level=ad&fields=' + encodeURIComponent('ad_name,adset_name,campaign_name,' + INSIGHT_FIELDS)
    + '&action_attribution_windows=' + encodeURIComponent(ATTR)
    + '&time_range=' + encodeURIComponent(JSON.stringify({ since, until })) + (inc ? '&time_increment=' + inc : '');
  const r = await pageAll(ACCT + '/insights', qs, 200, 20);
  if (r.error) throw new Error('Meta insights: ' + r.error);
  return r.rows.map(x => ({ ad_name: x.ad_name, adset: x.adset_name, campaign: x.campaign_name, date: x.date_start, ...shapePerf(x) }));
}
async function accountDaily(since, until) {
  const qs = 'level=account&fields=' + encodeURIComponent('spend,impressions,clicks,ctr,cpm,actions,action_values')
    + '&action_attribution_windows=' + encodeURIComponent(ATTR) + '&time_increment=1'
    + '&time_range=' + encodeURIComponent(JSON.stringify({ since, until }));
  const r = await pageAll(ACCT + '/insights', qs, 100, 5);
  if (r.error) throw new Error('Meta account: ' + r.error);
  return r.rows.map(x => { const s = shapePerf({ ...x, ad_id: 'account' }); return { date: x.date_start, spend: s.spend, impressions: s.impressions, clicks: s.clicks, ctr: s.ctr, cpm: s.cpm, p1c: s.purchases_1d_click, p7c: s.purchases_7d_click, p1v: s.purchases_1d_view, v7c: s.value_7d_click, atc: s.atc, ic: s.ic }; });
}
async function campaignConfig() {
  const c = await pageAll(ACCT + '/campaigns', 'fields=' + encodeURIComponent('name,status,effective_status,daily_budget,bid_strategy'), 100, 3);
  const a = await pageAll(ACCT + '/adsets', 'fields=' + encodeURIComponent('name,status,effective_status,daily_budget,campaign{name},learning_stage_info'), 100, 5);
  const ads = await pageAll(ACCT + '/ads', 'fields=' + encodeURIComponent('name,effective_status,created_time,adset{name}'), 200, 10);
  const acct = await graph(ACCT, 'fields=account_status,spend_cap,amount_spent');
  return { account: acct.json, campaigns: c.rows, adsets: a.rows, ads: ads.rows };
}

const ORDER_FIELDS = `
  name createdAt sourceName test
  currentTotalPriceSet{ shopMoney{ amount } }
  customer{ numberOfOrders }
  discountCodes
  lineItems(first:20){ nodes{ quantity product{ productType } } }
  customerJourneySummary{ momentsCount{ count } daysToConversion customerOrderIndex
    firstVisit{ source sourceType utmParameters{ source medium campaign } }
    lastVisit{ source sourceType referrerUrl utmParameters{ source medium campaign } } }`;

async function shopifyOrders(startNz, endNz) {
  const q = 'created_at:>=' + startNz + 'T00:00:00+12:00 AND created_at:<' + shift(endNz, 1) + 'T00:00:00+12:00';
  const build = 'query($q:String!,$after:String){ orders(first:100, query:$q, after:$after, sortKey:CREATED_AT){ pageInfo{ hasNextPage endCursor } nodes{ ' + ORDER_FIELDS + ' } } }';
  const out = []; let after = null;
  for (let g = 0; g < 20; g++) {
    const r = await gql(build, { q, after });
    const o = r && r.orders; if (!o) break;
    for (const n of o.nodes) {
      if (n.test) continue;
      const j = n.customerJourneySummary || {}; const lv = j.lastVisit || {}, fv = j.firstVisit || {};
      const types = {}; for (const li of ((n.lineItems && n.lineItems.nodes) || [])) { const t = (li.product && li.product.productType) || 'Other'; types[t] = (types[t] || 0) + (li.quantity || 0); }
      const utm = lv.utmParameters || {};
      out.push({ name: n.name, nz_date: NZ.format(new Date(n.createdAt)), amount: Number((n.currentTotalPriceSet && n.currentTotalPriceSet.shopMoney && n.currentTotalPriceSet.shopMoney.amount) || 0),
        channel: n.sourceName, customer_orders: n.customer ? n.customer.numberOfOrders : null, codes: n.discountCodes || [], types,
        moments: (j.momentsCount && j.momentsCount.count) || null, days_to_conv: j.daysToConversion == null ? null : j.daysToConversion,
        last_source: lv.source || null, last_type: lv.sourceType || null, last_ref: lv.referrerUrl || null,
        last_utm: [utm.source, utm.medium, utm.campaign].filter(Boolean).join('|') || null,
        first_source: fv.source || null, first_type: fv.sourceType || null,
        bucket: bucket(lv, n.discountCodes || []) });
    }
    if (!o.pageInfo.hasNextPage) break; after = o.pageInfo.endCursor;
  }
  return out;
}
const FB_CODES = /^(YUM20|TOPPINGS20|[A-Z0-9]+F)$/i;
function bucket(lv, codes) {
  const s = String(lv.source || '').toLowerCase(), t = String(lv.sourceType || '').toLowerCase();
  const u = lv.utmParameters || {}; const us = String(u.source || '').toLowerCase(), um = String(u.medium || '').toLowerCase();
  if (/facebook|instagram|meta|^fb$|^ig$/.test(s) || /facebook|instagram|meta|^fb$|^ig$/.test(us)) return t === 'paid' || /paid|cpc|ppc/.test(um) ? 'meta_paid' : 'meta_organic';
  if (/klaviyo|email/.test(s) || /email/.test(um)) return 'email';
  if (/google/.test(s) && (t === 'paid' || /cpc|ppc|paid/.test(um))) return 'google_paid';
  if (t === 'search' || /google|bing|duckduckgo/.test(s)) return 'search_organic';
  if (t === 'direct' || s === 'direct' || (!s && !t)) return 'direct';
  return 'other';
}
function summarise(orders) {
  const o = { orders: orders.length, sales: 0, new_customers: 0, by_bucket: {}, fb_code_orders: 0, codes: {}, types: {} };
  for (const x of orders) {
    o.sales += x.amount; if (x.customer_orders === 1) o.new_customers++;
    const b = o.by_bucket[x.bucket] || (o.by_bucket[x.bucket] = { orders: 0, sales: 0 }); b.orders++; b.sales += x.amount;
    for (const c of x.codes) { o.codes[c] = (o.codes[c] || 0) + 1; if (FB_CODES.test(c)) o.fb_code_orders++; }
    for (const t in x.types) o.types[t] = (o.types[t] || 0) + x.types[t];
  }
  o.sales = Math.round(o.sales * 100) / 100; for (const b in o.by_bucket) o.by_bucket[b].sales = Math.round(o.by_bucket[b].sales * 100) / 100;
  return o;
}

// day = NZ date being reported (default yesterday NZ).
async function gather(day) {
  const nzToday = NZ.format(new Date());
  const D = day || shift(nzToday, -1);
  const off = await nzToMetaOffsetDays();
  const mD = shift(D, off.days);
  const [adsDay, ads7, acct14, cfg, ordersDay, orders7] = await Promise.all([
    adInsights(mD, mD, null), adInsights(shift(mD, -6), mD, null), accountDaily(shift(mD, -13), mD), campaignConfig(),
    shopifyOrders(D, D), shopifyOrders(shift(D, -7), shift(D, -1)),
  ]);
  const dow = new Date(D + 'T12:00:00Z').toLocaleDateString('en-NZ', { weekday: 'long', timeZone: 'UTC' });
  const statusByName = {}; for (const a of cfg.ads) statusByName[a.name] = a.effective_status;
  for (const a of adsDay) a.status = statusByName[a.ad_name] || null;
  const acct14nz = acct14.map(r => ({ ...r, nz_date: shift(r.date, -off.days), dow: new Date(shift(r.date, -off.days) + 'T12:00:00Z').toLocaleDateString('en-NZ', { weekday: 'short', timeZone: 'UTC' }) }));
  const by7 = {}; for (const o of orders7) { const b = by7[o.nz_date] || (by7[o.nz_date] = { orders: 0, sales: 0 }); b.orders++; b.sales += o.amount; }
  return { nz_date: D, dow, meta_date: mD, offset_days: off.days,
    account: cfg.account, campaigns: cfg.campaigns, adsets: cfg.adsets.map(a => ({ name: a.name, status: a.effective_status, budget: a.daily_budget, campaign: a.campaign && a.campaign.name, learning: a.learning_stage_info && a.learning_stage_info.status })),
    account_14d: acct14nz, ads_day: adsDay.sort((a, b) => b.spend - a.spend), ads_7d: ads7.sort((a, b) => b.spend - a.spend),
    shopify_day: summarise(ordersDay), shopify_prev7_by_day: by7, orders_day: ordersDay };
}
module.exports = { gather };
