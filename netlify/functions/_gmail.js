// Shared Gmail helpers. Reads the single shared refresh token from the portal DB
// (service-role only) and exchanges it for a short-lived access token.
const { sb } = require('./_supa');
const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;

async function getToken() {
  const r = await sb('/rest/v1/gmail_tokens?id=eq.shared&select=email,refresh_token');
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] : null;
}
async function getAccessToken() {
  const t = await getToken();
  if (!t || !t.refresh_token) return { ok: false, error: 'Gmail is not connected yet.' };
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: t.refresh_token, grant_type: 'refresh_token' }),
  });
  const d = await res.json().catch(() => ({}));
  if (!d.access_token) return { ok: false, error: 'Could not refresh the Gmail connection. Please reconnect.' };
  return { ok: true, access_token: d.access_token, email: t.email };
}
module.exports = { getToken, getAccessToken };
