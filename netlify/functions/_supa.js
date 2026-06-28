// Shared helpers for portal admin functions.
// Uses the Supabase REST + Auth Admin API directly (no npm deps needed).
// The service role key is read from a Netlify environment variable and
// NEVER leaves the server.

const SUPABASE_URL = 'https://zpcbtfdjcsbdeqnizrpr.supabase.co';
const SERVICE_KEY = process.env.PORTAL_SERVICE_ROLE_KEY;

function json(status, obj) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}

// Authenticated request to Supabase using the service role key.
function sb(path, opts = {}) {
  return fetch(SUPABASE_URL + path, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

// Verify the caller's session token belongs to an active administrator.
// Returns { ok, callerId } or { ok:false, error }.
async function requireAdmin(event) {
  if (!SERVICE_KEY) return { ok: false, status: 500, error: 'Server not configured (missing PORTAL_SERVICE_ROLE_KEY).' };
  const header = event.headers.authorization || event.headers.Authorization || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, status: 401, error: 'Not authenticated.' };

  // Validate the token by resolving the user it belongs to.
  const ures = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token },
  });
  if (!ures.ok) return { ok: false, status: 401, error: 'Your session is invalid or expired. Please sign in again.' };
  const user = await ures.json();

  // Confirm the user is an active admin.
  const pres = await sb('/rest/v1/profiles?id=eq.' + user.id + '&select=is_admin,active');
  const rows = await pres.json().catch(() => []);
  if (!Array.isArray(rows) || !rows.length || !rows[0].is_admin || rows[0].active === false) {
    return { ok: false, status: 403, error: 'Administrator access required.' };
  }
  return { ok: true, callerId: user.id };
}

module.exports = { SUPABASE_URL, SERVICE_KEY, json, sb, requireAdmin };
