// TimeKeeper -> Scorecard weekly labour-hours sync.
// Phase 1 (current): DISCOVERY PROBE. TimeKeeper's REST schema/base host isn't in
// public docs, so this tries the likely hosts + date-param styles, pulls a small
// recent window, and records what came back into scoreboard.integration (row
// name='TimeKeeper') so we can learn the real shape without exposing the key.
// Once the shape + job list are known we switch this to the real aggregating sync.

const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
const TK_KEY   = process.env.TIMEKEEPER_API_KEY;

async function appsDb(path, opts = {}) {
  const headers = {
    apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'scoreboard', 'Content-Profile': 'scoreboard', ...(opts.headers || {}),
  };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + String(text).slice(0, 200));
  return data;
}

function tkAuth() { return 'Basic ' + Buffer.from(':' + (TK_KEY || '')).toString('base64'); }

async function recordProbe(note, ok) {
  const body = ok
    ? { last_success: new Date().toISOString(), last_error: null, last_error_at: null, note: note.slice(0, 4000) }
    : { last_error: note.slice(0, 900), last_error_at: new Date().toISOString() };
  await appsDb('integration?name=eq.TimeKeeper', {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body),
  });
}

exports.handler = async () => {
  if (!APPS_KEY) return { statusCode: 500, body: 'no APPS key' };
  if (!TK_KEY)  { await recordProbe('PROBE: TIMEKEEPER_API_KEY env var is not set on the server.', false); return { statusCode: 200, body: 'no tk key' }; }

  const d = new Date();
  const end = d.toISOString().slice(0, 10);
  const s = new Date(d); s.setUTCDate(d.getUTCDate() - 7);
  const start = s.toISOString().slice(0, 10);

  const hosts = ['https://api.timekeeper.co.uk', 'https://app.timekeeper.co.uk'];
  const paths = ['/api/tk/v1/time-entries'];
  const params = [
    `?start=${start}&end=${end}`,
    `?from=${start}&to=${end}`,
    `?startDate=${start}&endDate=${end}`,
    `?start_date=${start}&end_date=${end}`,
    '',
  ];

  const tried = [];
  let winner = null;
  try {
    outer:
    for (const h of hosts) for (const p of paths) for (const q of params) {
      const url = h + p + q;
      let status = 0, snippet = '';
      try {
        const res = await fetch(url, { headers: { Authorization: tkAuth(), Accept: 'application/json' } });
        status = res.status;
        const text = await res.text();
        snippet = text.slice(0, 120);
        tried.push({ url, status });
        if (res.ok) {
          let data = null; try { data = JSON.parse(text); } catch { data = null; }
          const arr = Array.isArray(data) ? data : (data && (data.data || data.entries || data.results || data.timeEntries)) || null;
          const sample = Array.isArray(arr) ? arr.slice(0, 2) : data;
          const keys = Array.isArray(arr) && arr[0] && typeof arr[0] === 'object' ? Object.keys(arr[0]) : (data && typeof data === 'object' ? Object.keys(data) : []);
          winner = { url, status, count: Array.isArray(arr) ? arr.length : null, keys, sample };
          break outer;
        }
      } catch (e) { tried.push({ url, status: 'ERR ' + String(e.message || e).slice(0, 60) }); }
    }

    const note = 'PROBE ' + new Date().toISOString() + ' window ' + start + '..' + end + '\n'
      + 'TRIED: ' + JSON.stringify(tried) + '\n'
      + (winner ? 'OK: ' + JSON.stringify(winner) : 'NO 2xx from any host/param combo');
    await recordProbe(note, !!winner);
    return { statusCode: 200, body: winner ? 'ok' : 'no-winner' };
  } catch (e) {
    await recordProbe('PROBE fatal: ' + String(e.message || e), false).catch(() => {});
    return { statusCode: 500, body: String(e) };
  }
};
