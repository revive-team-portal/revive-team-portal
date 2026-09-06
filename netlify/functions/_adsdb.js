// Supabase access for the Ads app (Revive Apps project, `ads` schema).
// Service role only — RLS is on with no policies, so the browser gets nothing
// directly and every read goes through a gated function.

const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
const BUCKET = 'ad-frames';

function h(extra) {
  return { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'ads', 'Content-Profile': 'ads', ...(extra || {}) };
}

async function db(path, opts = {}) {
  if (!APPS_KEY) throw new Error('missing APPS_SERVICE_ROLE_KEY');
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers: h(opts.headers) });
  const t = await res.text();
  if (!res.ok) throw new Error('DB ' + res.status + ' on ' + path.split('?')[0] + ': ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}

// Upsert in chunks — PostgREST is happy with a few hundred rows a time.
async function upsert(table, rows, onConflict, chunk = 200) {
  if (!rows || !rows.length) return 0;
  for (let i = 0; i < rows.length; i += chunk) {
    await db(table + '?on_conflict=' + onConflict, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows.slice(i, i + chunk)),
    });
  }
  return rows.length;
}

async function log(kind, ok, detail) {
  try { await db('sync_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ kind, ok, detail }]) }); }
  catch (e) { /* logging must never break the caller */ }
}

let _config = null;
async function config() {
  if (_config) return _config;
  const rows = await db('config?select=key,value').catch(() => []);
  const m = {};
  (rows || []).forEach(r => { m[r.key] = r.value; });
  _config = {
    model_tagging: m.model_tagging || 'claude-haiku-4-5-20251001',
    model_analysis: m.model_analysis || 'claude-opus-5',
    whisper_model: m.whisper_model || 'base.en',
    batch_size: Number(m.batch_size) || 5,
    brand_glossary: Array.isArray(m.brand_glossary) ? m.brand_glossary : [],
  };
  return _config;
}

// --- storage ---------------------------------------------------------------

async function putObject(path, buffer, contentType) {
  const res = await fetch(APPS_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
    method: 'POST',
    headers: { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY,
      'Content-Type': contentType || 'application/octet-stream', 'x-upsert': 'true' },
    body: buffer,
  });
  if (!res.ok) throw new Error('storage ' + res.status + ': ' + (await res.text()).slice(0, 160));
  return { path, public_url: APPS_URL + '/storage/v1/object/public/' + BUCKET + '/' + path };
}

async function getObject(path) {
  const res = await fetch(APPS_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
    headers: { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY },
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { APPS_URL, APPS_KEY, BUCKET, db, upsert, log, config, putObject, getObject };
