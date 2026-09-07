// TEMPORARY read-only Meta pull. Delete after use. ?k=<key>&since=YYYY-MM-DD&until=YYYY-MM-DD
const GRAPH = 'https://graph.facebook.com/v21.0';
const TOKEN = process.env.META_ACCESS_TOKEN;
const ACCT = process.env.META_AD_ACCOUNT || 'act_242089740673955';
const KEY = 'r7f2Qx91TmpAudit';
const WINDOWS = JSON.stringify(['1d_click', '7d_click', '1d_view']);
const FIELDS = 'spend,impressions,clicks,inline_link_clicks,ctr,cpc,reach,frequency,actions,action_values';

async function metaGet(path, params) {
  if (!TOKEN) throw new Error('missing META_ACCESS_TOKEN');
  let url = GRAPH + '/' + path + '?' + params + '&limit=500&access_token=' + encodeURIComponent(TOKEN);
  const all = [];
  for (let g = 0; g < 30 && url; g++) {
    const r = await fetch(url);
    const j = await r.json().catch(() => ({}));
    if (j.error) throw new Error('Meta ' + String(j.error.message || JSON.stringify(j.error)).slice(0, 300));
    if (!j.data) return j;
    j.data.forEach(x => all.push(x));
    url = (j.paging && j.paging.next) ? j.paging.next : null;
  }
  return all;
}

// collapse actions[] into { purchase: {1d_click, 7d_click, 1d_view}, ... }
function pick(row) {
  const want = {
    'purchase': 'purchase', 'omni_purchase': 'purchase_omni',
    'offsite_conversion.fb_pixel_purchase': 'purchase_pixel',
    'add_to_cart': 'atc', 'initiate_checkout': 'ic',
    'landing_page_view': 'lpv', 'link_click': 'link_click',
  };
  const out = { actions: {}, values: {} };
  for (const a of (row.actions || [])) {
    const k = want[a.action_type]; if (!k) continue;
    out.actions[k] = { d1c: Number(a['1d_click'] || 0), d7c: Number(a['7d_click'] || 0), d1v: Number(a['1d_view'] || 0), total: Number(a.value || 0) };
  }
  for (const a of (row.action_values || [])) {
    const k = want[a.action_type]; if (!k) continue;
    out.values[k] = { d1c: Number(a['1d_click'] || 0), d7c: Number(a['7d_click'] || 0), d1v: Number(a['1d_view'] || 0), total: Number(a.value || 0) };
  }
  return out;
}

exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== KEY) return { statusCode: 403, body: 'nope' };
  const since = qp.since, until = qp.until;
  const tr = encodeURIComponent(JSON.stringify({ since, until }));
  const common = 'time_range=' + tr + '&use_unified_attribution_setting=false&action_attribution_windows=' + encodeURIComponent(WINDOWS);
  try {
    const [acctInfo, daily, camps, ads] = await Promise.all([
      metaGet(ACCT, 'fields=' + encodeURIComponent('name,currency,timezone_name,account_status,amount_spent')),
      metaGet(ACCT + '/insights', 'level=account&fields=' + FIELDS + '&time_increment=1&' + common),
      metaGet(ACCT + '/insights', 'level=campaign&fields=campaign_name,' + FIELDS + '&' + common),
      metaGet(ACCT + '/insights', 'level=ad&fields=ad_name,campaign_name,' + FIELDS + '&' + common),
    ]);
    const norm = (r, extra) => ({
      ...extra, date: r.date_start, spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0,
      clicks: Number(r.clicks) || 0, link_clicks: Number(r.inline_link_clicks) || 0,
      reach: Number(r.reach) || 0, freq: Number(r.frequency) || 0,
      ctr: Number(r.ctr) || 0, cpc: Number(r.cpc) || 0, ...pick(r),
    });
    return {
      statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        account: acctInfo,
        daily: daily.map(r => norm(r, {})),
        campaigns: camps.map(r => norm(r, { campaign: r.campaign_name })).sort((a, b) => b.spend - a.spend),
        ads: ads.map(r => norm(r, { ad: r.ad_name, campaign: r.campaign_name })).sort((a, b) => b.spend - a.spend).slice(0, 25),
      }, null, 1),
    };
  } catch (e) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
