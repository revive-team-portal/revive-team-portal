// TEMPORARY read-only diagnostic. Deleted immediately after use.
const { gql } = require('./_shopify');
const KEY = 'zq7Xr2Lm9TnP4vKd';
const GRAPH = 'https://graph.facebook.com/v21.0';
const TOKEN = process.env.META_ACCESS_TOKEN;
const ACCT = process.env.META_AD_ACCOUNT || 'act_242089740673955';
const NZ = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });
const shift = (ymd, n) => { const x = new Date(ymd + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function g(path, params) {
  if (!TOKEN) throw new Error('missing META_ACCESS_TOKEN');
  let url = GRAPH + '/' + path + '?' + params + '&limit=300&access_token=' + encodeURIComponent(TOKEN);
  const all = [];
  for (let i = 0; i < 25 && url; i++) {
    const r = await fetch(url); const j = await r.json().catch(() => ({}));
    if (j.error) throw new Error('Meta ' + String(j.error.message || JSON.stringify(j.error)).slice(0, 300));
    if (!j.data) return j;
    j.data.forEach(x => all.push(x));
    url = (j.paging && j.paging.next) ? j.paging.next : null;
  }
  return all;
}

function acts(row) {
  const want = {
    'landing_page_view': 'lpv', 'add_to_cart': 'atc', 'omni_add_to_cart': 'atc_omni',
    'initiate_checkout': 'ic', 'omni_initiated_checkout': 'ic_omni',
    'purchase': 'purchase', 'omni_purchase': 'purchase_omni',
    'offsite_conversion.fb_pixel_purchase': 'pixel_purchase',
    'offsite_conversion.fb_pixel_view_content': 'pixel_vc',
    'offsite_conversion.fb_pixel_add_to_cart': 'pixel_atc',
    'offsite_conversion.fb_pixel_initiate_checkout': 'pixel_ic',
    'view_content': 'vc', 'link_click': 'link_click', 'page_engagement': 'page_eng',
    'post_engagement': 'post_eng', 'video_view': 'video_view',
  };
  const out = {};
  for (const a of (row.actions || [])) {
    if (!want[a.action_type]) continue;
    const k = want[a.action_type];
    out[k] = { total: Number(a.value) || 0 };
    if (a['1d_click'] != null) out[k].d1_click = Number(a['1d_click']) || 0;
    if (a['7d_click'] != null) out[k].d7_click = Number(a['7d_click']) || 0;
    if (a['1d_view'] != null) out[k].d1_view = Number(a['1d_view']) || 0;
  }
  for (const a of (row.action_values || [])) if (want[a.action_type]) out[want[a.action_type] + '_val'] = Number(a.value) || 0;
  return out;
}

const F = 'spend,impressions,clicks,inline_link_clicks,unique_clicks,ctr,inline_link_click_ctr,cpc,cpm,reach,frequency,quality_ranking,engagement_rate_ranking,conversion_rate_ranking,actions,action_values';
const AW = '&action_attribution_windows=' + encodeURIComponent('["1d_click","7d_click","1d_view"]');

function slim(r) {
  return {
    date: r.date_start, adset: r.adset_name, campaign: r.campaign_name, ad: r.ad_name,
    spend: Number(r.spend) || 0, impr: Number(r.impressions) || 0, reach: Number(r.reach) || 0,
    freq: Number(r.frequency) || 0, clicks: Number(r.clicks) || 0, link_clicks: Number(r.inline_link_clicks) || 0,
    ctr: Number(r.ctr) || 0, link_ctr: Number(r.inline_link_click_ctr) || 0, cpc: Number(r.cpc) || 0, cpm: Number(r.cpm) || 0,
    q_rank: r.quality_ranking, e_rank: r.engagement_rate_ranking, c_rank: r.conversion_rate_ranking,
    a: acts(r),
  };
}

exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== KEY) return { statusCode: 403, body: 'nope' };
  try {
    const acct = await g(ACCT, 'fields=name,currency,timezone_name,account_status,disable_reason,amount_spent,balance,spend_cap');
    const tz = acct.timezone_name || 'Etc/GMT+12';
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const now = new Date();
    const metaToday = f.format(now), nzToday = NZ.format(now);
    const since = shift(metaToday, -6), until = metaToday;

    const [adsetRows, adRows, hourly, adsets, ads, pixels] = await Promise.all([
      g(ACCT + '/insights', 'level=adset&fields=adset_name,campaign_name,' + F + '&time_increment=1&time_range=' + encodeURIComponent(JSON.stringify({ since, until })) + AW).catch(e => ({ error: String(e.message || e) })),
      g(ACCT + '/insights', 'level=ad&fields=ad_name,adset_name,campaign_name,' + F + '&time_range=' + encodeURIComponent(JSON.stringify({ since: metaToday, until: metaToday })) + AW).catch(e => ({ error: String(e.message || e) })),
      g(ACCT + '/insights', 'level=adset&fields=adset_name,spend,impressions,inline_link_clicks,actions&breakdowns=hourly_stats_aggregated_by_advertiser_time_zone&time_range=' + encodeURIComponent(JSON.stringify({ since: metaToday, until: metaToday })) + AW).catch(e => ({ error: String(e.message || e) })),
      g(ACCT + '/adsets', 'fields=name,status,effective_status,campaign{name,objective,status,effective_status,bid_strategy,daily_budget},daily_budget,lifetime_budget,bid_strategy,bid_amount,billing_event,optimization_goal,destination_type,promoted_object,attribution_spec,targeting,start_time,end_time,learning_stage_info,created_time,issues_info&effective_status=' + encodeURIComponent(JSON.stringify(['ACTIVE']))).catch(e => ({ error: String(e.message || e) })),
      g(ACCT + '/ads', 'fields=name,status,effective_status,adset{name},created_time,issues_info,creative{object_story_spec,effective_object_story_id,url_tags,link_url,object_type,call_to_action_type,asset_feed_spec},preview_shareable_link&effective_status=' + encodeURIComponent(JSON.stringify(['ACTIVE','WITH_ISSUES','PENDING_REVIEW','DISAPPROVED']))).catch(e => ({ error: String(e.message || e) })),
      g(ACCT + '/adspixels', 'fields=name,id,last_fired_time,is_unavailable').catch(e => ({ error: String(e.message || e) })),
    ]);

    let orders = null, oerr = null;
    try {
      const q = 'created_at:>=' + shift(nzToday, -2) + 'T00:00:00+12:00';
      const Q = 'query($q:String!){ orders(first:100, query:$q, sortKey:CREATED_AT){ nodes{ name createdAt sourceName currentTotalPriceSet{shopMoney{amount}} landingPageUrl referrerUrl customerJourneySummary{ customerOrderIndex daysToConversion firstVisit{source sourceType utmParameters{source medium campaign content term}} lastVisit{source sourceType referrerUrl landingPage utmParameters{source medium campaign content term}} } } } }';
      const r = await gql(Q, { q });
      orders = (r.orders.nodes || []).map(n => {
        const j = n.customerJourneySummary || {}, lv = j.lastVisit || {}, fv = j.firstVisit || {};
        const u = (x) => x.utmParameters ? [x.utmParameters.source, x.utmParameters.medium, x.utmParameters.campaign, x.utmParameters.content].filter(Boolean).join('|') : null;
        return { name: n.name, at: n.createdAt, nz: NZ.format(new Date(n.createdAt)),
          amt: Number(n.currentTotalPriceSet.shopMoney.amount), channel: n.sourceName,
          landing: (n.landingPageUrl || '').slice(0, 160), ref: (n.referrerUrl || '').slice(0, 120),
          idx: j.customerOrderIndex, dtc: j.daysToConversion,
          last: [lv.source, lv.sourceType].filter(Boolean).join('/'), last_utm: u(lv), last_landing: (lv.landingPage || '').slice(0, 160),
          first: [fv.source, fv.sourceType].filter(Boolean).join('/'), first_utm: u(fv) };
      });
    } catch (e) { oerr = String(e.message || e); }

    const clean = (a) => Array.isArray(a) ? a.map(x => {
      const t = x.targeting || {};
      return { name: x.name, status: x.effective_status, campaign: x.campaign && x.campaign.name, objective: x.campaign && x.campaign.objective,
        created: x.created_time, start: x.start_time, end: x.end_time,
        daily_budget: x.daily_budget ? Number(x.daily_budget) / 100 : null,
        camp_daily_budget: x.campaign && x.campaign.daily_budget ? Number(x.campaign.daily_budget) / 100 : null,
        opt_goal: x.optimization_goal, billing: x.billing_event, bid_strategy: x.bid_strategy, bid_amount: x.bid_amount,
        destination: x.destination_type, promoted: x.promoted_object, attribution: x.attribution_spec,
        learning: x.learning_stage_info, issues: x.issues_info,
        targeting: { geo: t.geo_locations, age: [t.age_min, t.age_max], genders: t.genders,
          interests: (t.flexible_spec || t.interests) ? JSON.stringify(t.flexible_spec || t.interests).slice(0, 600) : null,
          custom_audiences: t.custom_audiences, excluded_custom_audiences: t.excluded_custom_audiences,
          publisher_platforms: t.publisher_platforms, positions: [t.facebook_positions, t.instagram_positions].filter(Boolean),
          targeting_automation: t.targeting_automation, exclusions: t.exclusions ? JSON.stringify(t.exclusions).slice(0, 300) : null,
          targeting_optimization: t.targeting_optimization, locales: t.locales } };
    }) : a;

    const cleanAds = (a) => Array.isArray(a) ? a.map(x => {
      const c = x.creative || {}, s = c.object_story_spec || {};
      const ld = s.link_data || s.video_data || {};
      const afs = c.asset_feed_spec || {};
      return { name: x.name, status: x.effective_status, adset: x.adset && x.adset.name, created: x.created_time,
        issues: x.issues_info, url_tags: c.url_tags || null,
        link: ld.link || c.link_url || (afs.link_urls ? afs.link_urls.map(l => l.website_url) : null),
        cta: ld.call_to_action ? ld.call_to_action.type : c.call_to_action_type,
        headline: (ld.name || (afs.titles ? afs.titles.map(t => t.text).join(' / ') : '') || '').slice(0, 120),
        body: (ld.message || (afs.bodies ? afs.bodies.map(t => t.text).join(' / ') : '') || '').slice(0, 200),
        preview: x.preview_shareable_link };
    }) : a;

    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true, now_utc: now.toISOString(), meta_tz: tz, meta_today: metaToday, nz_today: nzToday,
        account: { name: acct.name, currency: acct.currency, status: acct.account_status, disable_reason: acct.disable_reason,
          amount_spent: Number(acct.amount_spent) / 100, balance: Number(acct.balance) / 100 },
        pixels,
        adset_daily: Array.isArray(adsetRows) ? adsetRows.map(slim).sort((a, b) => (a.date < b.date ? 1 : -1) || b.spend - a.spend) : adsetRows,
        ads_today: Array.isArray(adRows) ? adRows.map(slim).sort((a, b) => b.spend - a.spend) : adRows,
        hourly: Array.isArray(hourly) ? hourly.map(r => ({ hr: r.hourly_stats_aggregated_by_advertiser_time_zone, adset: r.adset_name, spend: Number(r.spend) || 0, impr: Number(r.impressions) || 0, lc: Number(r.inline_link_clicks) || 0, a: acts(r) })) : hourly,
        adsets_config: clean(adsets), ads_config: cleanAds(ads),
        shopify_orders: orders, shopify_error: oerr }, null, 1) };
  } catch (e) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(e.message || e), stack: String(e.stack || '').slice(0, 500) }) };
  }
};
