// Sends an email via the Gmail API using the connected shared mailbox. Portal-gated (sales).
const { json, validatePortalUser } = require('./_portal');
const { getAccessToken } = require('./_gmail');

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function encHeader(s){ return /[^\x00-\x7F]/.test(s||'') ? '=?UTF-8?B?' + Buffer.from(s).toString('base64') + '?=' : s; }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'sales');
  if (!a.ok) return json(a.status || 403, { error: a.error });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }
  const to = (body.to || '').trim();
  const subject = body.subject || '';
  const text = body.text || '';
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (!to) return json(400, { error: 'No recipient.' });

  const at = await getAccessToken();
  if (!at.ok) return json(400, { error: at.error });
  const from = body.from || at.email;

  let mime;
  const base = ['From: ' + from, 'To: ' + to, 'Subject: ' + encHeader(subject), 'MIME-Version: 1.0'];
  if (attachments.length) {
    const boundary = 'revb_' + Date.now();
    let m = base.concat(['Content-Type: multipart/mixed; boundary="' + boundary + '"']).join('\r\n') + '\r\n\r\n';
    m += '--' + boundary + '\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n' + text + '\r\n';
    for (const f of attachments) {
      m += '--' + boundary + '\r\n' +
        'Content-Type: ' + (f.mimeType || 'application/octet-stream') + '; name="' + f.filename + '"\r\n' +
        'Content-Transfer-Encoding: base64\r\n' +
        'Content-Disposition: attachment; filename="' + f.filename + '"\r\n\r\n' +
        (f.dataBase64 || '').replace(/(.{76})/g, '$1\r\n') + '\r\n';
    }
    m += '--' + boundary + '--';
    mime = m;
  } else {
    mime = base.concat(['Content-Type: text/plain; charset="UTF-8"']).join('\r\n') + '\r\n\r\n' + text;
  }

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: 'Bearer ' + at.access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64url(mime) }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return json(502, { error: (d.error && d.error.message) || 'Gmail send failed.' });
  return json(200, { id: d.id, threadId: d.threadId, from });
};
