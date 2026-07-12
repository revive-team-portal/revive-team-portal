// Resolve a ticket: archive its Gmail thread out of the cafe@ inbox, label it Revive/Resolved,
// and mark the ticket Resolved. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { getAccessToken } = require('./_gmail');
const { rest, hasKey } = require('./_appsdb');

let LABEL_ID = null;
async function ensureLabel(token){
  if (LABEL_ID) return LABEL_ID;
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', { headers:{ Authorization:'Bearer '+token } });
  const d = await r.json().catch(()=>({}));
  const found = (d.labels||[]).find(l => l.name === 'Revive/Resolved');
  if (found) { LABEL_ID = found.id; return LABEL_ID; }
  const cr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', { method:'POST', headers:{ Authorization:'Bearer '+token, 'Content-Type':'application/json' }, body: JSON.stringify({ name:'Revive/Resolved', labelListVisibility:'labelShow', messageListVisibility:'show' }) });
  const cd = await cr.json().catch(()=>({})); LABEL_ID = cd.id || null; return LABEL_ID;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  if (!body.id) return json(400, { error: 'No ticket id.' });
  try {
    const t = await rest('tickets?id=eq.'+encodeURIComponent(body.id)+'&select=gmail_thread_id&limit=1');
    if (!t || !t.length) return json(404, { error: 'Ticket not found.' });
    const threadId = t[0].gmail_thread_id;
    const at = await getAccessToken('cafe');
    if (at.ok && threadId) {
      const labelId = await ensureLabel(at.access_token);
      await fetch('https://gmail.googleapis.com/gmail/v1/users/me/threads/'+encodeURIComponent(threadId)+'/modify', {
        method:'POST', headers:{ Authorization:'Bearer '+at.access_token, 'Content-Type':'application/json' },
        body: JSON.stringify({ removeLabelIds:['INBOX'], addLabelIds: labelId ? [labelId] : [] }),
      });
    }
    await rest('tickets?id=eq.'+encodeURIComponent(body.id), { method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({ status:'Resolved', resolved_at:new Date().toISOString(), updated_at:new Date().toISOString() }) });
    return json(200, { ok:true, archived: !!(at.ok && threadId) });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
