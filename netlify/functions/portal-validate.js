const { validatePortalUser } = require('./_portal');

const PORTAL_URL  = 'https://zpcbtfdjcsbdeqnizrpr.supabase.co';
const PORTAL_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpwY2J0ZmRqY3NiZGVxbml6cnByIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwODkzNDcsImV4cCI6MjA5MzY2NTM0N30.chmQ9vY8vc0Yyu81d-a6bccIgGsFIIRrdo6kEKFS79w';
const APPS_URL    = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_ANON   = 'sb_publishable_UQWjPFJDl7uUZkIMUWJQXA_LvLSKAVl';
const ADMIN_EMAIL = 'jobs@revivealicious.com';

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://jobs.revive.co.nz',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: '{"error":"Method not allowed"}' };

  let token;
  try { ({ token } = JSON.parse(event.body || '{}')); } catch {
    return { statusCode: 400, headers, body: '{"error":"Bad request"}' };
  }
  if (!token) return { statusCode: 400, headers, body: '{"error":"No token"}' };

  // 1. Validate the portal session AND confirm this user is allowed the jobs app
  const auth = await validatePortalUser({ headers: { authorization: `Bearer ${token}` } }, 'jobs');
  if (!auth.ok) {
    const status = auth.status || 403;
    return { statusCode: status, headers, body: JSON.stringify({ error: status === 401 ? 'Invalid portal token' : auth.error }) };
  }

  // 2. Generate magic link for jobs admin user
  const SVC = process.env.APPS_SERVICE_ROLE_KEY;
  const linkRes = await fetch(`${APPS_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { 'apikey': SVC, 'Authorization': `Bearer ${SVC}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email: ADMIN_EMAIL })
  });
  if (!linkRes.ok) return { statusCode: 500, headers, body: '{"error":"Link generation failed"}' };
  const linkData = await linkRes.json();

  // 3. Verify immediately server-side using email_otp (single-use token)
  const verifyRes = await fetch(`${APPS_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'apikey': APPS_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token: linkData.email_otp, email: ADMIN_EMAIL })
  });
  if (!verifyRes.ok) return { statusCode: 500, headers, body: '{"error":"Verify failed"}' };
  const session = await verifyRes.json();

  if (!session.access_token) return { statusCode: 500, headers, body: '{"error":"No session returned"}' };

  return { statusCode: 200, headers, body: JSON.stringify({
    valid: true,
    access_token: session.access_token,
    refresh_token: session.refresh_token
  })};
};
