// Sends a reply from cafe@ (threaded), appending the editable footer, and records it. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { getAccessToken } = require('./_gmail');
const { rest, hasKey } = require('./_appsdb');

function b64url(buf){ return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function encHeader(s){ return /[^\x00-\x7F]/.test(s||'') ? '=?UTF-8?B?'+Buffer.from(s).toString('base64')+'?=' : (s||''); }
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Ticket database not configured.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }
  const to = (body.to||'').trim(); let text = (body.text||'').trim();
  if (!to || !text) return json(400, { error: 'Recipient and message are required.' });
  if (!body.id) return json(400, { error: 'No ticket id.' });

  try {
    const t = await rest('tickets?id=eq.'+encodeURIComponent(body.id)+'&select=gmail_thread_id,subject&limit=1');
    if (!t || !t.length) return json(404, { error: 'Ticket not found.' });
    const threadId = t[0].gmail_thread_id;
    let subject = body.subject || t[0].subject || 'Re: your enquiry';
    if (!/^re:/i.test(subject)) subject = 'Re: ' + subject;

    // append the editable footer unless it's already present
    let footer=''; try { const fr = await rest('settings?select=value&key=eq.reply_footer'); footer = (fr && fr[0] && fr[0].value) || ''; } catch(e){}
    if (footer && !text.includes(footer)) text = text + '\n\n' + footer;

    const at = await getAccessToken('cafe');
    if (!at.ok) return json(400, { error: at.error });
    const from = at.email || 'cafe@revive.co.nz';

    const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;white-space:pre-wrap">'+esc(text)+'</div>';
    const altB = 'alt_'+Date.now();
    const mime = ['From: '+from, 'To: '+to, 'Subject: '+encHeader(subject), 'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="'+altB+'"'].join('\r\n') + '\r\n\r\n'
      + '--'+altB+'\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n'+text+'\r\n'
      + '--'+altB+'\r\nContent-Type: text/html; charset="UTF-8"\r\n\r\n'+html+'\r\n--'+altB+'--';

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method:'POST', headers:{ Authorization:'Bearer '+at.access_token, 'Content-Type':'application/json' },
      body: JSON.stringify(threadId ? { raw:b64url(mime), threadId:String(threadId) } : { raw:b64url(mime) }),
    });
    const d = await res.json().catch(()=>({}));
    if (!res.ok) return json(502, { error: (d.error&&d.error.message)||'Gmail send failed.' });

    await rest('messages', { method:'POST', headers:{ Prefer:'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({
      gmail_message_id: d.id, ticket_id: body.id, direction:'outbound', from_addr: from, to_addr: to, body: text, sent_at: new Date().toISOString(), is_ai_draft: false }) });
    await rest('tickets?id=eq.'+encodeURIComponent(body.id), { method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({ status:'Awaiting Customer', updated_at:new Date().toISOString() }) });

    return json(200, { ok:true, id:d.id, threadId:d.threadId });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
