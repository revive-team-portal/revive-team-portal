// Read-only TimeKeeper daily hours. ?k=..&start=YYYY-MM-DD&end=YYYY-MM-DD[&job_id=72232]
// Returns per-NZ-day hours for the job, broken down by employee. Writes nothing.
// TimeKeeper caps time-entries at 7 days per pull, so the range is chunked.
// All TK times are UTC; entries are attributed to the NZ calendar date of start_time.
const GUARD = 'rvp-tk-7Kq3';
const TK_KEY = process.env.TIMEKEEPER_API_KEY;
const BASE = 'https://api.timekeeper.co.uk/api/tk/v1';
const NZ = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });

const auth = () => 'Basic ' + Buffer.from(':' + (TK_KEY || '')).toString('base64');
const shift = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nzDate = (iso) => NZ.format(new Date(iso));

async function tkGet(path) {
  const res = await fetch(BASE + path, { headers: { Authorization: auth(), Accept: 'application/json' } });
  if (!res.ok) throw new Error('TK ' + res.status + ' on ' + path.split('?')[0] + ': ' + (await res.text()).slice(0, 160));
  return res.json();
}

// TK wraps list payloads as { <key>: { <key>: [...], total_pages, page } }
function unwrap(body, key) {
  const box = body && body[key] ? body[key] : body || {};
  return { rows: box[key] || box.results || [], total: box.total_pages || 1 };
}

async function pageAll(path, key) {
  let page = 1, total = 1, all = [];
  do {
    const body = await tkGet(`${path}${path.includes('?') ? '&' : '?'}page=${page}`);
    const { rows, total: t } = unwrap(body, key);
    total = t; all = all.concat(rows); page++;
  } while (page <= total && page <= 60);
  return all;
}

async function employeeNames() {
  try {
    const rows = await pageAll('/employees', 'employees');
    const map = {};
    for (const e of rows) {
      const n = e.name || [e.first_name, e.last_name].filter(Boolean).join(' ') || e.full_name || ('#' + e.id);
      map[e.id] = n;
    }
    return map;
  } catch (e) { return { _error: String(e.message || e) }; }
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if (q.k !== GUARD) return { statusCode: 401, body: 'no' };
  if (!TK_KEY) return { statusCode: 500, body: 'missing TIMEKEEPER_API_KEY' };
  const start = q.start, end = q.end;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) {
    return { statusCode: 400, body: 'start and end required as YYYY-MM-DD' };
  }
  const jobId = q.job_id || '72232';

  try {
    const names = await employeeNames();
    // pad one day each side so UTC-stored entries near the NZ boundary are caught
    const windows = [];
    for (let s = shift(start, -1); s <= end; s = shift(s, 7)) {
      windows.push([s, [shift(s, 6), shift(end, 1)].sort()[0]]);
    }
    let entries = [];
    for (const [s, e] of windows) {
      entries = entries.concat(await pageAll(`/time-entries?start_date=${s}&end_date=${e}&job_id=${jobId}`, 'time_entries'));
    }
    const seen = new Set();
    const days = {};
    for (const en of entries) {
      if (seen.has(en.id)) continue; seen.add(en.id);
      const d = nzDate(en.start_time);
      if (d < start || d > end) continue;
      const who = names[en.employee_id] || ('#' + en.employee_id);
      const h = Number(en.duration_in_hours_raw) || 0;
      days[d] = days[d] || { date: d, hours: 0, people: {}, entries: 0 };
      days[d].hours += h; days[d].entries++;
      days[d].people[who] = (days[d].people[who] || 0) + h;
    }
    const out = Object.values(days).sort((a, b) => a.date < b.date ? -1 : 1).map(d => ({
      date: d.date, hours: Math.round(d.hours * 100) / 100, entries: d.entries,
      people: Object.entries(d.people).sort((a, b) => b[1] - a[1]).map(([name, hours]) => ({ name, hours: Math.round(hours * 100) / 100 })),
    }));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: Number(jobId), start, end, raw_entries: entries.length, days: out }) };
  } catch (e) {
    return { statusCode: 500, body: String(e.message || e) };
  }
};
