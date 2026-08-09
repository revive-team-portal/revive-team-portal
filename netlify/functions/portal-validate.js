// Validates a Revive Portal session, then issues a Supabase magic-link OTP
// for the jobs admin user so admin.html can log in without re-entering credentials.
const PORTAL_URL  = 'https://zpcbtfdjcsbdeqnizrpr.supabase.co';
const PORTAL_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpwY2J0ZmRqY3NiZGVxbml6cnByIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwODkzNDcsImV4cCI6MjA5MzY2NTM0N30.chmQ9vY8vc0Yyu81d-a6bccIgGsFIIRrdo6kEKFS79w';
const APPS_URL    = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const ADMIN_EMAIL = 'jobs@revivealicious.com';

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://jobs.revive.co.nz',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: '{"error":"Method not allowed"}' };

  let token;
  try { ({ token } = JSON.parse(event.body || '{}')); } catch {
    return { statusCode: 400, headers, body: '{"error":"Bad request"}' };
  }
  if (!token) return { statusCode: 400, headers, body: '{"error":"No token"}' };

  // 1. Validate the portal access token
  const userRes = await fetch(`${PORTAL_URL}/auth/v1/user`, {
    headers: { 'apikey': PORTAL_ANON, 'Authorization': `Bearer ${token}` }
  });
  if (!userRes.ok) return { statusCode: 401, headers, body: '{"error":"Invalid portal token"}' };

  // 2. Generate a magic-link OTP for the jobs admin user
  const SVC = process.env.APPS_SERVICE_ROLE_KEY;
  const linkRes = await fetch(`${APPS_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { 'apikey': SVC, 'Authorization': `Bearer ${SVC}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email: ADMIN_EMAIL })
  });
  if (!linkRes.ok) {
    const err = await linkRes.text();
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Auth generation failed', detail: err }) };
  }

  const linkData = await linkRes.json();
  const actionLink = linkData.action_link || (linkData.properties && linkData.properties.action_link);
  if (!actionLink) return { statusCode: 500, headers, body: '{"error":"No action link"}' };

  const otp = new URL(actionLink).searchParams.get('token');
  return { statusCode: 200, headers, body: JSON.stringify({ valid: true, otp, email: ADMIN_EMAIL }) };
};
