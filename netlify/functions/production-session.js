// Hands a portal-authenticated user (with `production` access) a session into the
// Revive Apps project, reusing the existing shared service account. The password
// never reaches the browser. Operator/supervisor is a role classification handled
// separately (UI + role-checked functions), not a separate login.

const { json, validatePortalUser } = require('./_portal');

const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_ANON = 'sb_publishable_UQWjPFJDl7uUZkIMUWJQXA_LvLSKAVl';
const APP_EMAIL = 'sales-app@revive.co.nz';
const APP_PASSWORD = process.env.SALES_APP_PASSWORD;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!APP_PASSWORD) return json(500, { error: 'Server not configured (SALES_APP_PASSWORD).' });

  const auth = await validatePortalUser(event, 'production');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });

  const res = await fetch(APPS_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: APPS_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: APP_EMAIL, password: APP_PASSWORD }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) return json(500, { error: 'Could not open the production database session.' });

  return json(200, {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    portal_user: { id: auth.user.id, email: auth.user.email },
  });
};
