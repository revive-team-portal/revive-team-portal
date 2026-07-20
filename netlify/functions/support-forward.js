// Forward a ticket's latest email to another address, from cafe@. Portal-gated (support).
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
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  const to = (body.to||'').trim(); if (!to || !body.id) return json(400, { error: 'Recipient and ticket required.' });
  try {
    const t = await rest('tickets?id=eq.'+encodeURIComponent(body.id)+'&select=subject,customer_id,customer:customers(name,email)&limit=1');
    if (!t || !t.length) return json(404, { error: 'Ticket not found.' });
    const tk = t[0]; const cust = tk.customer || {};
    const m = await rest('messages?ticket_id=eq.'+encodeURIComponent(body.id)+'&select=from_addr,body,sent_at&order=sent_at.desc&limit=1');
    const last = (m && m[0]) || {};
    const at = await getAccessToken('cafe');
    if (!at.ok) return json(400, { error: at.error });
    const from = at.email || 'cafe@revive.co.nz';
    const subject = 'Fwd: ' + (tk.subject || 'Customer email');
    const note = (body.note||'').trim();
    const header = 'From: '+(cust.name||'')+' <'+(cust.email||last.from_addr||'')+'>\nDate: '+(last.sent_at||'')+'\nSubject: '+(tk.subject||'');
    const text = (note?note+'\n\n':'') + '---------- Forwarded message ----------\n' + header + '\n\n' + (last.body||'');
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;white-space:pre-wrap">'+esc(text)+'</div>';
    const altB='alt_'+Date.now();
    const mime=['From: '+from,'To: '+to,'Subject: '+encHeader(subject),'MIME-Version: 1.0','Content-Type: multipart/alternative; boundary="'+altB+'"'].join('\r\n')+'\r\n\r\n'
      +'--'+altB+'\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n'+text+'\r\n'
      +'--'+altB+'\r\nContent-Type: text/html; charset="UTF-8"\r\n\r\n'+html+'\r\n--'+altB+'--';
    const res=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',headers:{Authorization:'Bearer '+at.access_token,'Content-Type':'application/json'},body:JSON.stringify({raw:b64url(mime)})});
    const d=await res.json().catch(()=>({}));
    if(!res.ok) return json(502,{error:(d.error&&d.error.message)||'Forward failed.'});
    if(tk.customer_id) await rest('interactions',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({ customer_id:tk.customer_id, ticket_id:body.id, channel:'email', direction:'out', operator:a.user.email||'operator', note:'Forwarded to '+to+(note?(' — '+note):''), occurred_at:new Date().toISOString() })});
    return json(200,{ ok:true });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
