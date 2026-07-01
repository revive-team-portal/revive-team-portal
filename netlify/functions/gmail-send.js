// Sends an HTML email (with a branded footer banner) via Gmail. Portal-gated (sales).
const { json, validatePortalUser } = require('./_portal');
const { getAccessToken } = require('./_gmail');

const FOOTER_IMG = 'https://revivealicious.com/cdn/shop/files/2x1_Banner_2026_75600d3d-3499-4602-af5f-77a29db1fd87.jpg?width=1000';
function b64url(buf){ return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function encHeader(s){ return /[^\x00-\x7F]/.test(s||'') ? '=?UTF-8?B?'+Buffer.from(s).toString('base64')+'?=' : (s||''); }
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

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
  const banner = (body.bannerUrl && String(body.bannerUrl).trim()) || FOOTER_IMG;

  const footer = banner ? '<br><a href="https://revivealicious.com"><img src="' + banner + '" alt="Revivealicious Foods" style="display:block;max-width:600px;width:100%;height:auto;border:0"></a>' : '';
  const quote = (typeof body.quote === 'string' && body.quote.trim()) ? body.quote : '';
  const quoteHtml = quote ? '<br><br><div style="color:#777;font-size:13px;border-left:2px solid #ccc;padding-left:10px;white-space:pre-wrap">' + esc(quote) + '</div>' : '';
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;white-space:pre-wrap">' + esc(text) + '</div>' + footer + quoteHtml;

  const altB = 'alt_' + Date.now();
  const plain = text + (quote ? '\r\n\r\n' + quote : '');
  const alt = '--' + altB + '\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n' + plain + '\r\n' +
              '--' + altB + '\r\nContent-Type: text/html; charset="UTF-8"\r\n\r\n' + html + '\r\n' +
              '--' + altB + '--';
  const headers = ['From: ' + from, 'To: ' + to, 'Subject: ' + encHeader(subject), 'MIME-Version: 1.0'];

  let mime;
  if (attachments.length) {
    const mixB = 'mix_' + Date.now();
    let m = headers.concat(['Content-Type: multipart/mixed; boundary="' + mixB + '"']).join('\r\n') + '\r\n\r\n';
    m += '--' + mixB + '\r\nContent-Type: multipart/alternative; boundary="' + altB + '"\r\n\r\n' + alt + '\r\n';
    for (const f of attachments) {
      m += '--' + mixB + '\r\n' +
        'Content-Type: ' + (f.mimeType || 'application/octet-stream') + '; name="' + f.filename + '"\r\n' +
        'Content-Transfer-Encoding: base64\r\n' +
        'Content-Disposition: attachment; filename="' + f.filename + '"\r\n\r\n' +
        (f.dataBase64 || '').replace(/(.{76})/g, '$1\r\n') + '\r\n';
    }
    m += '--' + mixB + '--';
    mime = m;
  } else {
    mime = headers.concat(['Content-Type: multipart/alternative; boundary="' + altB + '"']).join('\r\n') + '\r\n\r\n' + alt;
  }

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: 'Bearer ' + at.access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body.threadId ? { raw: b64url(mime), threadId: String(body.threadId) } : { raw: b64url(mime) }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return json(502, { error: (d.error && d.error.message) || 'Gmail send failed.' });
  return json(200, { id: d.id, threadId: d.threadId, from });
};
