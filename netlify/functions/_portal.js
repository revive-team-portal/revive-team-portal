// Shared validator: confirms a caller is a logged-in portal user with access to a given app.
// Used by app-specific functions (recipes-session, ai-proxy, ...) to gate access.

const PORTAL_URL = 'https://zpcbtfdjcsbdeqnizrpr.supabase.co';
// Portal anon (publishable) key — public by design, safe to embed.
const PORTAL_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpwY2J0ZmRqY3NiZGVxbml6cnByIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwODkzNDcsImV4cCI6MjA5MzY2NTM0N30.chmQ9vY8vc0Yyu81d-a6bccIgGsFIIRrdo6kEKFS79w';
const PORTAL_SERVICE = process.env.PORTAL_SERVICE_ROLE_KEY;

function json(status, obj) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

// Returns { ok:true, user } if the caller is an active portal user who is either
// an admin or has been granted `requiredApp`. Otherwise { ok:false, status, error }.
async function validatePortalUser(event, requiredApp) {
  if (!PORTAL_SERVICE) return { ok: false, status: 500, error: 'Server not configured (PORTAL_SERVICE_ROLE_KEY).' };
  const token = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, status: 401, error: 'Not authenticated.' };

  const ures = await fetch(PORTAL_URL + '/auth/v1/user', { headers: { apikey: PORTAL_ANON, Authorization: 'Bearer ' + token } });
  if (!ures.ok) return { ok: false, status: 401, error: 'Your session is invalid or expired. Please sign in again.' };
  const user = await ures.json();

  const pres = await fetch(PORTAL_URL + '/rest/v1/profiles?id=eq.' + user.id + '&select=is_admin,active', {
    headers: { apikey: PORTAL_SERVICE, Authorization: 'Bearer ' + PORTAL_SERVICE },
  });
  const prof = (await pres.json().catch(() => []))[0];
  if (!prof || prof.active === false) return { ok: false, status: 403, error: 'No access.' };
  if (prof.is_admin) return { ok: true, user };

  const ares = await fetch(PORTAL_URL + '/rest/v1/user_app_access?user_id=eq.' + user.id + '&app_id=eq.' + encodeURIComponent(requiredApp) + '&select=app_id', {
    headers: { apikey: PORTAL_SERVICE, Authorization: 'Bearer ' + PORTAL_SERVICE },
  });
  const acc = await ares.json().catch(() => []);
  if (!Array.isArray(acc) || !acc.length) return { ok: false, status: 403, error: 'You do not have access to this app.' };
  return { ok: true, user };
}

module.exports = { PORTAL_URL, PORTAL_ANON, json, validatePortalUser };
