// Meta Marketing API access for the Ads app.
//
// Two things here are easy to get wrong and both have cost time before:
//   * The ad account runs on Etc/GMT+12, exactly one day behind NZ. The offset
//     is derived live rather than hardcoded.
//   * Purchases must be reported split by attribution window. Meta's default
//     blended number flatters view-through, so `actions` are read per window.

const GRAPH = 'https://graph.facebook.com/v21.0';
const TOKEN = process.env.META_ACCESS_TOKEN;
const ACCT = process.env.META_AD_ACCOUNT || 'act_242089740673955';
const NZ = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });

const nzToday = () => NZ.format(new Date());
const shift = (ymd, n) => { const x = new Date(ymd + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function graph(path, qs) {
  if (!TOKEN) throw new Error('missing META_ACCESS_TOKEN');
  const res = await fetch(GRAPH + '/' + path + '?' + (qs || '') + '&access_token=' + encodeURIComponent(TOKEN));
  const j = await res.json().catch(() => ({}));
  return { http: res.status, json: j, err: j.error ? String(j.error.message || '').slice(0, 220) : null };
}

// Page an edge. Two different failures need two different answers:
//   * "reduce the amount of data" is about payload size — back the page size off.
//   * "Service temporarily unavailable" / rate limiting is about timing — wait
//     and try the same call again. Shrinking the page there just makes more
//     calls into an API that is already asking us to slow down. The lifetime
//     insights call was silently lost to this while the backfill was running.
const TRANSIENT = /temporarily unavailable|rate limit|please reduce the number|user request limit|too many calls|\(#17\)|\(#4\)|\(#341\)|an unexpected error/i;
const OVERSIZED = /reduce the amount of data|an unknown error occurred/i;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function pageAll(path, qs, startLimit, maxPages) {
  const limits = [startLimit || 50, 25, 10, 5];
  let lastErr = null;
  for (const lim of limits) {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(attempt * 8000);
      let url = GRAPH + '/' + path + '?' + qs + '&limit=' + lim + '&access_token=' + encodeURIComponent(TOKEN);
      const all = []; let err = null; let pages = 0;
      for (let i = 0; i < (maxPages || 120) && url; i++) {
        const r = await fetch(url);
        const j = await r.json().catch(() => ({}));
        if (j.error) { err = String(j.error.message || '').slice(0, 220); break; }
        (j.data || []).forEach(d => all.push(d)); pages++;
        url = (j.paging && j.paging.next) ? j.paging.next : null;
      }
      if (!err) return { rows: all, pages, error: null, limit_used: lim, attempts: attempt + 1 };
      lastErr = err;
      if (TRANSIENT.test(err)) continue;          // same page size, just wait
      if (OVERSIZED.test(err)) break;             // smaller page size
      return { rows: all, pages, error: err, limit_used: lim };
    }
  }
  return { rows: [], pages: 0, error: lastErr, limit_used: null };
}

// Multi-get with automatic chunk shrinking, so one awkward object can't cost
// us the whole batch.
async function multiGet(ids, fields, chunk = 25) {
  const out = {}; const failed = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const r = await fetch(GRAPH + '/?ids=' + encodeURIComponent(slice.join(',')) + '&fields=' + encodeURIComponent(fields)
      + '&access_token=' + encodeURIComponent(TOKEN));
    const j = await r.json().catch(() => ({}));
    if (j.error) {
      if (chunk > 1) { const sub = await multiGet(slice, fields, Math.max(1, Math.floor(chunk / 5))); Object.assign(out, sub.map); sub.failed.forEach(f => failed.push(f)); }
      else failed.push({ id: slice[0], error: String(j.error.message || '').slice(0, 160) });
    } else Object.keys(j).forEach(k => { out[k] = j[k]; });
    await new Promise(x => setTimeout(x, 100));
  }
  return { map: out, failed };
}

let _tz = null;
async function accountTz() {
  if (_tz) return _tz;
  const r = await graph(ACCT, 'fields=timezone_name');
  _tz = (r.json && r.json.timezone_name) || 'Etc/GMT+12';
  return _tz;
}
async function nzToMetaOffsetDays() {
  const tz = await accountTz();
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const now = new Date();
  return { tz, days: Math.round((Date.parse(f.format(now) + 'T00:00:00Z') - Date.parse(NZ.format(now) + 'T00:00:00Z')) / 86400000) };
}

// --- insights --------------------------------------------------------------

const INSIGHT_FIELDS = ['ad_id', 'spend', 'impressions', 'reach', 'clicks', 'ctr', 'cpm', 'cpc', 'frequency',
  'inline_link_clicks', 'actions', 'action_values', 'video_play_actions',
  'video_thruplay_watched_actions', 'video_avg_time_watched_actions',
  'video_p25_watched_actions', 'video_p50_watched_actions', 'video_p75_watched_actions',
  'video_p95_watched_actions', 'video_p100_watched_actions'].join(',');

const ATTR = '1d_view,7d_click,1d_click';

// Pull a numeric action value, optionally from one attribution window.
function actVal(actions, type, win) {
  const a = (actions || []).find(x => x.action_type === type);
  if (!a) return 0;
  if (win) return Number(a[win] || 0);
  return Number(a.value || 0);
}
function firstOf(actions, types, win) {
  for (const t of types) { const v = actVal(actions, t, win); if (v) return v; }
  return 0;
}

const PURCHASE_TYPES = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];

const firstArr = (v) => (Array.isArray(v) && v[0] ? Number(v[0].value) || 0 : 0);

function shapePerf(row, win) {
  const acts = row.actions || [];
  const vals = row.action_values || [];
  // video_play_actions counts an autoplay start, which on feed placements is
  // ~86% of impressions — a measure of placement, not of stopping the scroll.
  // The 3-second play (action_type `video_view`) is the honest hook numerator;
  // where the account does not return it, 25%-watched is the next best thing
  // and hook_rate_basis records which was used.
  const plays = firstArr(row.video_play_actions);
  const thru = firstArr(row.video_thruplay_watched_actions);
  const p25 = firstArr(row.video_p25_watched_actions);
  const p50 = firstArr(row.video_p50_watched_actions);
  const p75 = firstArr(row.video_p75_watched_actions);
  const p95 = firstArr(row.video_p95_watched_actions);
  const p100 = firstArr(row.video_p100_watched_actions);
  const avgWatch = firstArr(row.video_avg_time_watched_actions);
  const v3s = actVal(acts, 'video_view');
  const impressions = Number(row.impressions) || 0;

  const rate = (num, den) => (den ? Math.round(10000 * num / den) / 10000 : null);
  const hookNum = v3s || p25;
  const hookBasis = v3s ? '3s_plays' : (p25 ? 'p25_watched' : null);

  const spend = Number(row.spend) || 0;
  const purch7 = firstOf(acts, PURCHASE_TYPES, '7d_click');
  const value7 = firstOf(vals, PURCHASE_TYPES, '7d_click');
  const purch1v = firstOf(acts, PURCHASE_TYPES, '1d_view');
  const value1v = firstOf(vals, PURCHASE_TYPES, '1d_view');
  // Ads Manager's default headline: 7-day click PLUS 1-day view. Reported as
  // the primary figure so the app agrees with the screen Jeremy actually looks
  // at; the click-only pair sits beside it as the conservative read.
  const purchMeta = purch7 + purch1v;
  const valueMeta = value7 + value1v;

  return {
    ad_id: row.ad_id, win,
    spend: Number(row.spend) || 0,
    impressions, reach: Number(row.reach) || 0,
    clicks: Number(row.clicks) || 0,
    ctr: Number(row.ctr) || 0, cpm: Number(row.cpm) || 0,
    frequency: Number(row.frequency) || 0,
    link_clicks: Number(row.inline_link_clicks) || 0,
    // Split by window, never the blended default.
    purchases_1d_click: firstOf(acts, PURCHASE_TYPES, '1d_click'),
    purchases_7d_click: firstOf(acts, PURCHASE_TYPES, '7d_click'),
    purchases_1d_view: firstOf(acts, PURCHASE_TYPES, '1d_view'),
    value_7d_click: value7,
    value_1d_view: value1v,
    purchases_meta: purchMeta,
    value_meta: valueMeta,
    cpa_meta: purchMeta ? Math.round(100 * spend / purchMeta) / 100 : null,
    roas_meta: spend ? Math.round(100 * valueMeta / spend) / 100 : null,
    atc: firstOf(acts, ['omni_add_to_cart', 'add_to_cart']),
    ic: firstOf(acts, ['omni_initiated_checkout', 'initiate_checkout']),
    video_plays: plays, thruplays: thru,
    video_3s: v3s || null, video_p25: p25 || null, video_p50: p50 || null,
    video_p75: p75 || null, video_p95: p95 || null, video_p100: p100 || null,
    avg_watch_sec: avgWatch || null,
    // Hook: did the creative stop the scroll. Hold: did it keep them to a ThruPlay.
    hook_rate: rate(hookNum, impressions),
    hook_rate_basis: hookBasis,
    hold_rate: rate(thru, hookNum || plays),
    thruplay_rate: rate(thru, impressions),
    completion_rate: rate(p100, impressions),
    roas: spend ? Math.round(100 * value7 / spend) / 100 : null,
    cpa: purch7 ? Math.round(100 * spend / purch7) / 100 : null,
    cpc: Number(row.cpc) || null,
    updated_at: new Date().toISOString(),
  };
}

// One call per window, at ad level, across the whole account.
async function insights(datePreset, timeIncrement) {
  const qs = 'level=ad&fields=' + encodeURIComponent(INSIGHT_FIELDS)
    + '&action_attribution_windows=' + encodeURIComponent(ATTR)
    + '&date_preset=' + datePreset
    + (timeIncrement ? '&time_increment=' + timeIncrement : '');
  return pageAll(ACCT + '/insights', qs, 200, 60);
}

module.exports = { GRAPH, ACCT, NZ, nzToday, shift, graph, pageAll, multiGet,
  accountTz, nzToMetaOffsetDays, insights, shapePerf, INSIGHT_FIELDS, ATTR };
