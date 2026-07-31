// TimeKeeper -> Scorecard sync. Phase 1: DISCOVERY PROBE v2.
// api.timekeeper.co.uk is the real API (returns 422 = params invalid). Capture the
// response BODY for each attempt so we can read the validation message, and try
// several date formats. Results -> scoreboard.integration (name='TimeKeeper').
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
const TK_KEY   = process.env.TIMEKEEPER_API_KEY;
const BASE = 'https://api.timekeeper.co.uk/api/tk/v1/time-entries';

async function appsDb(path, opts = {}) {
  const headers = { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'scoreboard', 'Content-Profile': 'scoreboard', ...(opts.headers || {}) };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const text = await res.text();
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + String(text).slice(0, 200));
  return text ? JSON.parse(text) : null;
}
function tkAuth() { return 'Basic ' + Buffer.from(':' + (TK_KEY || '')).toString('base64'); }
async function record(note, ok) {
  const body = ok ? { last_success: new Date().toISOString(), last_error: null, note: note.slice(0, 4000) }
                  : { last_error: 'see note', last_error_at: new Date().toISOString(), note: note.slice(0, 4000) };
  await appsDb('integration?name=eq.TimeKeeper', { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) });
}
exports.handler = async () => {
  if (!APPS_KEY || !TK_KEY) return { statusCode: 500, body: 'missing keys' };
  const today = new Date();
  const dOff = (n) => { const x = new Date(today); x.setUTCDate(today.getUTCDate() - n); return x.toISOString().slice(0, 10); };
  const s = dOff(7), e = dOff(1);                 // last week, ending yesterday
  const sISO = s + 'T00:00:00Z', eISO = e + 'T23:59:59Z';
  const attempts = [
    `?start=${s}&end=${e}`,
    `?start=${sISO}&end=${eISO}`,
    `?from=${sISO}&to=${eISO}`,
    `?startDate=${sISO}&endDate=${eISO}`,
    `?start=${s}&end=${e}&page=1`,
    `?start=${s}&end=${e}&limit=50`,
    `?date=${s}`,
  ];
  const tried = [];
  let winner = null;
  try {
    for (const q of attempts) {
      const url = BASE + q;
      try {
        const res = await fetch(url, { headers: { Authorization: tkAuth(), Accept: 'application/json' } });
        const text = await res.text();
        tried.push({ q, status: res.status, body: text.slice(0, 180) });
        if (res.ok) {
          let data = null; try { data = JSON.parse(text); } catch {}
          const arr = Array.isArray(data) ? data : (data && (data.data || data.entries || data.results || data.timeEntries || data.items)) || null;
          if (Array.isArray(arr)) {
            winner = { q, count: arr.length, keys: arr[0] ? Object.keys(arr[0]) : [], sample: arr.slice(0, 2) };
            break;
          } else { winner = { q, note: 'ok but not an array', top: data && typeof data === 'object' ? Object.keys(data) : typeof data, sample: data }; break; }
        }
      } catch (err) { tried.push({ q, status: 'ERR', body: String(err.message || err).slice(0, 120) }); }
    }
    const note = 'PROBE2 ' + new Date().toISOString() + ' win ' + s + '..' + e + '\nTRIED:\n' + tried.map(t => JSON.stringify(t)).join('\n') + '\n' + (winner ? 'WINNER: ' + JSON.stringify(winner) : 'no 2xx');
    await record(note, !!winner);
    return { statusCode: 200, body: winner ? 'ok' : 'no-winner' };
  } catch (e2) { await record('PROBE2 fatal: ' + String(e2.message || e2), false).catch(() => {}); return { statusCode: 500, body: String(e2) }; }
};
