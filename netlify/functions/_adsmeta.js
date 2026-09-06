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

// Page an edge, backing the page size off when Meta complains the payload is
// too big (a function of fields x limit, not of the total result set).
async function pageAll(path, qs, startLimit, maxPages) {
  const limits = [startLimit || 50, 25, 10, 5];
  let lastErr = null;
  for (const lim of limits) {
    let url = GRAPH + '/' + path + '?' + qs + '&limit=' + lim + '&access_token=' + encodeURIComponent(TOKEN);
    const all = []; let err = null; let pages = 0;
    for (let i = 0; i < (maxPages || 120) && url; i++) {
      const r = await fetch(url); const j = await r.json().catch(() => ({}));
      if (j.error) { err = String(j.error.message || '').slice(0, 220); break; }
      (j.data || []).forEach(d => all.push(d)); pages++;
      url = (j.paging && j.paging.next) ? j.paging.next : null;
    }
    if (!err) return { rows: all, pages, error: null, limit_used: lim };
    lastErr = err;
    if (!/reduce the amount of data|unknown error/i.test(err)) return { rows: all, pages, error: err, limit_used: lim };
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

const INSIGHT_FIELDS = ['ad_id', 'spend', 'impressions', 'reach', 'clicks', 'ctr', 'cpm', 'frequency',
  'inline_link_clicks', 'actions', 'action_values', 'video_play_actions',
  'video_thruplay_watched_actions', 'video_p25_watched_actions'].join(',');

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

function shapePerf(row, win) {
  const acts = row.actions || [];
  const vals = row.action_values || [];
  const plays = Number((row.video_play_actions || [])[0] ? row.video_play_actions[0].value : 0) || 0;
  const thru = Number((row.video_thruplay_watched_actions || [])[0] ? row.video_thruplay_watched_actions[0].value : 0) || 0;
  const impressions = Number(row.impressions) || 0;
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
    value_7d_click: firstOf(vals, PURCHASE_TYPES, '7d_click'),
    atc: firstOf(acts, ['omni_add_to_cart', 'add_to_cart']),
    ic: firstOf(acts, ['omni_initiated_checkout', 'initiate_checkout']),
    video_plays: plays, thruplays: thru,
    hook_rate: impressions ? Math.round(10000 * plays / impressions) / 10000 : null,
    hold_rate: plays ? Math.round(10000 * thru / plays) / 10000 : null,
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
