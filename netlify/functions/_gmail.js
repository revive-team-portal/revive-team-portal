// Shared Gmail helpers. Reads a shared refresh token from the portal DB (service-role only)
// and exchanges it for a short-lived access token. Supports multiple mailboxes by id
// (e.g. 'shared' = sales/hello@, 'cafe' = cafe@revive.co.nz support mailbox).
const { sb } = require('./_supa');
const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;

async function getToken(id = 'shared') {
  const r = await sb('/rest/v1/gmail_tokens?id=eq.' + encodeURIComponent(id) + '&select=email,refresh_token');
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] : null;
}
async function getAccessToken(id = 'shared') {
  const t = await getToken(id);
  if (!t || !t.refresh_token) return { ok: false, error: 'This mailbox is not connected yet.' };
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: t.refresh_token, grant_type: 'refresh_token' }),
  });
  const d = await res.json().catch(() => ({}));
  if (!d.access_token) return { ok: false, error: 'Could not refresh the Gmail connection. Please reconnect.' };
  return { ok: true, access_token: d.access_token, email: t.email };
}
function b64url(buf){ return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function encHeader(x){ return /[^\x00-\x7F]/.test(x||'') ? '=?UTF-8?B?'+Buffer.from(x).toString('base64')+'?=' : (x||''); }
// Send a simple HTML email from the shared mailbox. `to` may be a comma-separated list.
async function sendMail({ to, subject, html, text }) {
  const at = await getAccessToken('shared');
  if (!at.ok) return { ok: false, error: at.error };
  const from = at.email;
  const altB = 'alt_' + Date.now();
  const plain = text || '';
  const bodyHtml = html || ('<pre>' + (text || '') + '</pre>');
  const alt = '--' + altB + '\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n' + plain + '\r\n' +
              '--' + altB + '\r\nContent-Type: text/html; charset="UTF-8"\r\n\r\n' + bodyHtml + '\r\n--' + altB + '--';
  const headers = ['From: ' + from, 'To: ' + to, 'Subject: ' + encHeader(subject), 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="' + altB + '"'];
  const mime = headers.join('\r\n') + '\r\n\r\n' + alt;
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: 'Bearer ' + at.access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64url(mime) }) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: (d.error && d.error.message) || 'Gmail send failed' };
  return { ok: true, id: d.id, from };
}
module.exports = { getToken, getAccessToken, sendMail };
