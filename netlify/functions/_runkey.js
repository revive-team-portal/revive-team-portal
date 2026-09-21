// One guard for every non-browser entry point (Claude tools, maintenance runs,
// background workers). Nothing secret is committed. Three ways in:
//
//   1. header  x-internal: <token>   — server-to-server calls between our own
//      functions (crons kicking background workers). The token is derived from
//      APPS_SERVICE_ROLE_KEY, so it exists only inside Netlify. Use internalFetch().
//   2. ?k=<PORTAL_RUN_KEY>           — optional Netlify env key (currently unset).
//   3. ?k=<single-use run key>       — minted into ads.job on Revive Apps:
//        INSERT INTO ads.job (kind,status,cursor,note)
//        VALUES ('runkey','open',encode(gen_random_bytes(18),'hex'),'<why>') RETURNING cursor;
//      Valid 30 minutes, burned on first use. This is how Claude calls the tools.
//
// Browser-facing functions do NOT use this — they use _portal.validatePortalUser.

const crypto = require('crypto');
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
const GUARD = process.env.PORTAL_RUN_KEY;
const NONCE_TTL_MS = 30 * 60 * 1000;
const SITE = process.env.URL || 'https://team.revive.co.nz';

function adsHeaders(extra) {
  return { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'ads', 'Content-Profile': 'ads', ...(extra || {}) };
}
async function adsDb(path, opts = {}) {
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers: adsHeaders(opts.headers) });
  const t = await res.text();
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function internalToken() {
  return APPS_KEY ? crypto.createHash('sha256').update('revive-portal-internal:' + APPS_KEY).digest('hex') : null;
}
function isInternal(event) {
  const h = (event && event.headers) || {};
  const t = internalToken();
  return !!t && same(String(h['x-internal'] || h['X-Internal'] || ''), t);
}

// ?k= run key (env or single-use). Returns { ok, how, job_id? }.
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
  await adsDb('job?id=eq.' + row.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'used', cursor: null, finished_at: new Date().toISOString() }) }).catch(() => {});
  return { ok: true, how: 'runkey', job_id: row.id };
}

// Internal call OR run key. Use at the top of every worker / tool.
async function guard(event) {
  if (isInternal(event)) return { ok: true, how: 'internal' };
  return authorizeRun(event);
}
const DENY = { statusCode: 403, body: 'nope' };

// Call another of our functions with the internal header. name = 'foo-background?x=1'
function internalFetch(name, opts = {}) {
  return fetch(SITE + '/.netlify/functions/' + name, { method: 'POST', ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}), 'x-internal': internalToken() } });
}

module.exports = { guard, authorizeRun, isInternal, internalFetch, internalToken, DENY, adsDb, adsHeaders, APPS_URL, APPS_KEY };
