// Meta (Facebook) Ads -> Scorecard weekly ad spend via the Marketing API insights
// endpoint. Pulls daily account spend (account timezone), buckets into NZ Sat–Fri
// weeks -> ad_spend (source='meta'). Never clobbers a manual override.
// Requires env META_ACCESS_TOKEN (a never-expiring ads_read token). Ad account
// defaults to act_242089740673955 (override with META_AD_ACCOUNT).
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
const TOKEN = process.env.META_ACCESS_TOKEN;
const ACCT = process.env.META_AD_ACCOUNT || 'act_242089740673955';
const GRAPH = 'https://graph.facebook.com/v21.0';

async function appsDb(path, opts = {}) {
  const headers = { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'scoreboard', 'Content-Profile': 'scoreboard', ...(opts.headers || {}) };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const t = await res.text(); if (!res.ok) throw new Error('DB ' + res.status + ': ' + t.slice(0, 160));
  return t ? JSON.parse(t) : null;
}
function weekEndFri(ymd) { const d = new Date(ymd + 'T00:00:00Z'); const add = (5 - d.getUTCDay() + 7) % 7; d.setUTCDate(d.getUTCDate() + add); return d.toISOString().slice(0, 10); }

async function fetchInsights(since, until) {
  if (!TOKEN) throw new Error('missing META_ACCESS_TOKEN');
  let url = GRAPH + '/' + ACCT + '/insights?level=account&fields=spend&time_increment=1'
    + '&time_range=' + encodeURIComponent(JSON.stringify({ since, until }))
    + '&limit=500&access_token=' + encodeURIComponent(TOKEN);
  const all = [];
  for (let g = 0; g < 300 && url; g++) {
    const res = await fetch(url);
    const j = await res.json().catch(() => ({}));
    if (j.error) throw new Error('Meta ' + String(j.error.message || JSON.stringify(j.error)).slice(0, 180));
    (j.data || []).forEach(d => all.push(d));
    url = (j.paging && j.paging.next) ? j.paging.next : null;
  }
  return all;
}

async function syncMeta(start, end) {
  const days = await fetchInsights(start, end);
  const wk = {};
  for (const d of days) { const we = weekEndFri(d.date_start); wk[we] = (wk[we] || 0) + (Number(d.spend) || 0); }
  const weekRows = await appsDb('week?select=period_end');
  const exist = new Set((weekRows || []).map(x => x.period_end));
  const today = new Date().toISOString().slice(0, 10);
  const ov = await appsDb("fact?select=period_end,metric_code&period_type=eq.week&is_override=eq.true&metric_code=in.(ad_spend)");
  const ovSet = new Set((ov || []).map(r => r.metric_code + '|' + r.period_end));
  const rows = []; const written = [];
  for (const we of Object.keys(wk)) {
    if (!exist.has(we) || we > today) continue;
    if (!ovSet.has('ad_spend|' + we)) rows.push({ metric_code: 'ad_spend', period_type: 'week', period_end: we, value: Math.round(wk[we] * 100) / 100, source: 'meta', quality: 'ok', entered_at: new Date().toISOString() });
    written.push(we);
  }
  for (let i = 0; i < rows.length; i += 400) await appsDb('fact?on_conflict=metric_code,period_type,period_end', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 400)) });
  await appsDb("integration?name=eq.Meta", { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_success: new Date().toISOString(), last_error: null, note: 'sync ' + new Date().toISOString() + ' weeks=' + written.length }) }).catch(() => {});
  return { days: days.length, weeks: written.length, sample: wk[weekEndFri(end)] };
}
async function spendRange(since, until) {
  if (!TOKEN) throw new Error('missing META_ACCESS_TOKEN');
  const url = GRAPH + '/' + ACCT + '/insights?level=account&fields=spend'
    + '&time_range=' + encodeURIComponent(JSON.stringify({ since, until }))
    + '&access_token=' + encodeURIComponent(TOKEN);
  const res = await fetch(url); const j = await res.json().catch(() => ({}));
  if (j.error) throw new Error('Meta ' + String(j.error.message || '').slice(0, 160));
  return Number((j.data && j.data[0] && j.data[0].spend) || 0);
}
let _acctTz = null;
async function metaAccountTz() {
  if (_acctTz) return _acctTz;
  try {
    const res = await fetch(GRAPH + '/' + ACCT + '?fields=timezone_name&access_token=' + encodeURIComponent(TOKEN));
    const j = await res.json().catch(() => ({}));
    _acctTz = (j && j.timezone_name) || 'Etc/GMT+12';
  } catch (e) { _acctTz = 'Etc/GMT+12'; }
  return _acctTz;
}
module.exports = { syncMeta, spendRange, metaAccountTz };
