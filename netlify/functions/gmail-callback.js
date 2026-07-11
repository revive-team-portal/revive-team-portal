// Exchanges the OAuth code for tokens and stores the refresh token server-side,
// under the mailbox id carried in `state` ('shared' = sales, 'cafe' = support).
const { sb } = require('./_supa');
const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT = 'https://team.revive.co.nz/.netlify/functions/gmail-callback';

function page(msg, back) {
  return { statusCode: 200, headers: { 'Content-Type': 'text/html' },
    body: '<html><body style="font-family:system-ui,sans-serif;padding:48px;text-align:center;color:#292524">' +
          '<img src="https://www.revive.co.nz/cdn/shop/files/01-060_Revive_Cafe_Logo_240x.png?v=1626572048" style="width:48px;height:48px;mix-blend-mode:multiply">' +
          '<h2 style="margin:16px 0">' + msg + '</h2><p><a href="' + back + '" style="color:#0f766e">← Back to portal</a></p></body></html>' };
}

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const mailbox = qs.state === 'cafe' ? 'cafe' : 'shared';
  const back = mailbox === 'cafe' ? '/support/' : '/sales/';
  if (qs.error) return page('Connection cancelled (' + qs.error + ').', back);
  if (!qs.code) return page('No authorisation code was returned. Please try connecting again.', back);

  const tok = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: qs.code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: 'authorization_code' }),
  });
  const data = await tok.json().catch(() => ({}));
  if (data.error) return page('Google returned an error: ' + (data.error_description || data.error), back);
  if (!data.refresh_token) return page('Connected, but Google did not return a refresh token. Remove the app under your Google Account → Security → Third-party access, then reconnect.', back);

  let email = '';
  try { email = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64').toString()).email || ''; } catch (e) {}

  await sb('/rest/v1/gmail_tokens?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ id: mailbox, email, refresh_token: data.refresh_token, updated_at: new Date().toISOString() }),
  });
  return page('Gmail connected' + (email ? ' as ' + email : '') + '. You can close this tab.', back);
};
