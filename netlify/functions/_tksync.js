// Shared TimeKeeper -> Scorecard sync logic. Used by the scheduled wrapper
// (timekeeper-sync) and the guarded manual endpoint (tk-run).
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
const TK_KEY   = process.env.TIMEKEEPER_API_KEY;
const TK = 'https://api.timekeeper.co.uk/api/tk/v1/time-entries';
const NZ_HOLIDAYS = { '2026-01-01':'New Year','2026-01-02':'Day after New Year','2026-01-26':'Auckland Anniversary','2026-02-06':'Waitangi Day','2026-04-03':'Good Friday','2026-04-06':'Easter Monday','2026-04-25':'ANZAC Day','2026-06-01':'Kings Birthday','2026-07-10':'Matariki','2026-10-26':'Labour Day','2026-12-25':'Christmas','2026-12-26':'Boxing Day' };

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

async function runSync(nWeeks, daysOnly) {
  if (!APPS_KEY || !TK_KEY) throw new Error('missing APPS_SERVICE_ROLE_KEY or TIMEKEEPER_API_KEY');
  const maps = await appsDb('tk_job_map?select=job_id,metric_code,active');
  const jobMetric = {}; (maps || []).forEach(m => { if (m.active && m.metric_code) jobMetric[m.job_id] = m.metric_code; });
  const weeks = await appsDb('week?select=period_end,trading_days,holiday&order=period_end.desc&limit=' + nWeeks);
  const fridays = (weeks || []).map(w => w.period_end);

  const fetched = await Promise.all(fridays.map(async F => {
    const start = addDays(F, -6);
    try { return { F, start, entries: await fetchWeekEntries(start, F) }; }
    catch (e) { return { F, start, error: String(e.message || e) }; }
  }));

  const summary = [];
  for (const w of fetched) {
    if (w.error) { summary.push({ week: w.F, error: w.error }); continue; }
    const per = {};
    for (const e of w.entries) {
      const mc = jobMetric[e.job_id]; if (!mc) continue;
      const nz = nzDate(e.start_time); if (nz < w.start || nz > w.F) continue;
      per[mc] = (per[mc] || 0) + (Number(e.duration_in_hours_raw) || 0);
    }
    // Trading days = distinct NZ dates the cafe had front-of-house staff. Only set
    // it when the week doesn't already have a (manually entered) value.
    const wkRow = (weeks || []).find(x => x.period_end === w.F);
    if (wkRow) {
      const patch = {};
      if (wkRow.trading_days === null || wkRow.trading_days === undefined) {
        const fohDates = new Set();
        for (const e of w.entries) { if (jobMetric[e.job_id] === 'hours_foh_cafe') { const nz = nzDate(e.start_time); if (nz >= w.start && nz <= w.F) fohDates.add(nz); } }
        if (fohDates.size > 0) patch.trading_days = fohDates.size;
      }
      if (wkRow.holiday === null || wkRow.holiday === undefined) {
        for (const dt in NZ_HOLIDAYS) { if (dt >= w.start && dt <= w.F) { patch.holiday = NZ_HOLIDAYS[dt]; break; } }
      }
      if (Object.keys(patch).length) await appsDb('week?period_end=eq.' + w.F, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    }
    if (daysOnly) { summary.push({ week: w.F, entries: w.entries.length, daysOnly: true }); continue; }
    const codes = Object.keys(per);
    if (!codes.length) { summary.push({ week: w.F, entries: w.entries.length, wrote: 0 }); continue; }
    const ex = await appsDb(`fact?select=metric_code,is_override&period_type=eq.week&period_end=eq.${w.F}&metric_code=in.(${codes.join(',')})`);
    const overridden = new Set((ex || []).filter(r => r.is_override).map(r => r.metric_code));
    const rows = codes.filter(c => !overridden.has(c)).map(c => ({
      metric_code: c, period_type: 'week', period_end: w.F, value: Math.round(per[c] * 100) / 100,
      source: 'timekeeper', quality: 'ok', entered_at: new Date().toISOString(),
    }));
    if (rows.length) await appsDb('fact?on_conflict=metric_code,period_type,period_end', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
    summary.push({ week: w.F, entries: w.entries.length, wrote: rows.length, skippedOverride: codes.length - rows.length });
  }
  const anyErr = summary.some(s => s.error);
  await appsDb('integration?name=eq.TimeKeeper', { method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(anyErr
      ? { last_error: 'partial: ' + JSON.stringify(summary).slice(0, 480), last_error_at: new Date().toISOString() }
      : { last_success: new Date().toISOString(), last_error: null, last_error_at: null, note: 'sync ' + new Date().toISOString() + ' ' + JSON.stringify(summary).slice(0, 3400) }) });
  return summary;
}
module.exports = { runSync, fetchWeekEntries, addDays };
