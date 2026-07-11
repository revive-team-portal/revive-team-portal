// Server-side data layer for the support schema in the Revive Apps project.
// Uses the Apps service-role key (RLS bypassed) — support PII never touches the browser.
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const KEY = process.env.APPS_SERVICE_ROLE_KEY;

function hasKey(){ return !!KEY; }

async function rest(path, opts = {}) {
  if (!KEY) throw new Error('Server not configured (APPS_SERVICE_ROLE_KEY missing).');
  const headers = {
    apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'support', 'Content-Profile': 'support', ...(opts.headers || {}),
  };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 300));
  return data;
}

// Upsert helper returning the representation rows.
async function upsert(table, row, onConflict) {
  const q = 'rest' === 'rest' ? table + '?on_conflict=' + onConflict : table;
  return rest(q, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(row) });
}

module.exports = { rest, upsert, hasKey, APPS_URL };
