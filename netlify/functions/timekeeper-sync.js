// TimeKeeper -> Scorecard weekly labour-hours sync.
// Pulls time entries per week (Sat–Fri, NZ), maps TimeKeeper jobs to hours_* metrics
// via scoreboard.tk_job_map, and upserts weekly hour facts (source='timekeeper').
// Runs on a daily schedule (netlify.toml); also triggerable via guarded HTTP GET.
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
const TK_KEY   = process.env.TIMEKEEPER_API_KEY;
const TK = 'https://api.timekeeper.co.uk/api/tk/v1/time-entries';
const GUARD = 'rvp-tk-7Kq3';               // temporary manual-run guard
const WEEKS = 6;                            // how many recent weeks to (re)sync each run

async function appsDb(path, opts = {}) {
  const headers = { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'scoreboard', 'Content-Profile': 'scoreboard', ...(opts.headers || {}) };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const text = await res.text();
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + String(text).slice(0, 160));
  return text ? JSON.parse(text) : null;
}
function tkAuth() { return 'Basic ' + Buffer.from(':' + (TK_KEY || '')).toString('base64'); }
function addDays(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function nzDate(iso) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); }

async function fetchWeekEntries(start, end) {
  let page = 1, total = 1, all = [];
  do {
    const res = await fetch(`${TK}?start_date=${start}&end_date=${end}&page=${page}`, { headers: { Authorization: tkAuth(), Accept: 'application/json' } });
    if (!res.ok) throw new Error('TK ' + res.status + ': ' + (await res.text()).slice(0, 120));
    const box = (await res.json()).time_entries || {};
    total = box.total_pages || 1;
    all = all.concat(box.time_entries || []);
    page++;
  } while (page <= total);
  return all;
}

async function run() {
  const maps = await appsDb('tk_job_map?select=job_id,metric_code,active');
  const jobMetric = {}; (maps || []).forEach(m => { if (m.active && m.metric_code) jobMetric[m.job_id] = m.metric_code; });

  const weeks = await appsDb('week?select=period_end&order=period_end.desc&limit=' + WEEKS);
  const fridays = (weeks || []).map(w => w.period_end);

  const summary = [];
  for (const F of fridays) {
    const start = addDays(F, -6);
    const entries = await fetchWeekEntries(start, F);
    const per = {};
    for (const e of entries) {
      const mc = jobMetric[e.job_id]; if (!mc) continue;
      const nz = nzDate(e.start_time); if (nz < start || nz > F) continue;   // keep to this NZ week
      per[mc] = (per[mc] || 0) + (Number(e.duration_in_hours_raw) || 0);
    }
    const codes = Object.keys(per);
    if (!codes.length) { summary.push({ week: F, entries: entries.length, wrote: 0 }); continue; }
    // don't clobber manual overrides
    const ex = await appsDb(`fact?select=metric_code,is_override&period_type=eq.week&period_end=eq.${F}&metric_code=in.(${codes.join(',')})`);
    const overridden = new Set((ex || []).filter(r => r.is_override).map(r => r.metric_code));
    const rows = codes.filter(c => !overridden.has(c)).map(c => ({
      metric_code: c, period_type: 'week', period_end: F, value: Math.round(per[c] * 100) / 100,
      source: 'timekeeper', quality: 'ok', entered_at: new Date().toISOString(),
    }));
    if (rows.length) await appsDb('fact?on_conflict=metric_code,period_type,period_end', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
    summary.push({ week: F, entries: entries.length, wrote: rows.length, skippedOverride: codes.length - rows.length });
  }
  await appsDb('integration?name=eq.TimeKeeper', { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_success: new Date().toISOString(), last_error: null, last_error_at: null, note: 'sync ' + new Date().toISOString() + ' ' + JSON.stringify(summary).slice(0, 3500) }) });
  return summary;
}

exports.handler = async (event) => {
  if (!APPS_KEY || !TK_KEY) return { statusCode: 500, body: 'missing keys' };
  if (event && event.httpMethod && (event.queryStringParameters || {}).k !== GUARD) return { statusCode: 403, body: 'nope' };
  try {
    const summary = await run();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, summary }, null, 1) };
  } catch (e) {
    await appsDb('integration?name=eq.TimeKeeper', { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_error: String(e.message || e).slice(0, 500), last_error_at: new Date().toISOString() }) }).catch(() => {});
    return { statusCode: 500, body: String(e.message || e) };
  }
};
