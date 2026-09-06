// Guard for Ads maintenance/back-office endpoints (probe, backfill, sync).
//
// Two ways in, both server-side only — nothing secret is ever committed:
//   1. ?k=<PORTAL_RUN_KEY>          — the existing Netlify env guard key.
//   2. ?k=<one-time run key>        — a single-use key sat in ads.job
//      (kind='runkey', status='open'), readable only with the service role.
//      Expires after 30 minutes and is consumed on first successful use.
//
// (2) exists so an operator with database access can trigger a run without the
// env key ever passing through a browser, a repo, or a chat transcript.

const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
const GUARD = process.env.PORTAL_RUN_KEY;
const NONCE_TTL_MS = 30 * 60 * 1000;

function adsHeaders(extra) {
  return {
    apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'ads', 'Content-Profile': 'ads', ...(extra || {}),
  };
}

async function adsDb(path, opts = {}) {
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers: adsHeaders(opts.headers) });
  const t = await res.text();
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}

// Constant-time-ish compare so a wrong key leaks nothing through timing.
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function authorizeRun(event) {
  const qp = (event && event.queryStringParameters) || {};
  const k = qp.k;
  if (!k) return { ok: false, how: null };
  if (GUARD && same(k, GUARD)) return { ok: true, how: 'env' };
  if (!APPS_KEY) return { ok: false, how: null };

  let rows = [];
  try { rows = await adsDb('job?kind=eq.runkey&status=eq.open&select=id,cursor,started_at') || []; }
  catch (e) { return { ok: false, how: null }; }

  const now = Date.now();
  const row = rows.find(r => same(String(r.cursor || ''), k) && (now - Date.parse(r.started_at)) < NONCE_TTL_MS);
  if (!row) return { ok: false, how: null };

  // Burn it immediately — single use, whatever happens next.
  await adsDb('job?id=eq.' + row.id, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'used', cursor: null, finished_at: new Date().toISOString() }),
  }).catch(() => {});

  return { ok: true, how: 'runkey', job_id: row.id };
}

module.exports = { authorizeRun, adsDb, adsHeaders, APPS_URL, APPS_KEY };
