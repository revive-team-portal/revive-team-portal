// Search the whole mailbox (All Mail) for a customer's past conversations. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { getAccessToken } = require('./_gmail');
function parseEmail(s){ const m=(s||'').match(/<([^>]+)>/); return (m?m[1]:(s||'')).trim(); }
async function gapi(token, path){ const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{headers:{Authorization:'Bearer '+token}}); return r.json().catch(()=>({})); }
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  const email = (body.email||'').trim(); const query = (body.query||'').trim();
  const months = Math.min(Number(body.months)||12, 60);
  if (!email && !query) return json(400, { error: 'Enter an email or search text.' });
  const at = await getAccessToken('cafe');
  if (!at.ok) return json(400, { error: at.error });
  const q = (email ? ('(from:'+email+' OR to:'+email+')') : query) + ' newer_than:'+months+'m';
  try {
    const list = await gapi(at.access_token, 'messages?maxResults=40&q=' + encodeURIComponent(q));
    const ids = (list.messages||[]).map(m=>m.id).slice(0,40);
    const byThread = {};
    for (const id of ids) {
      const m = await gapi(at.access_token, 'messages/'+id+'?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date');
      const h={}; ((m.payload&&m.payload.headers)||[]).forEach(x=>h[x.name.toLowerCase()]=x.value);
      const t=m.threadId; const ts=Number(m.internalDate||0);
      const item={ threadId:t, from:h.from||'', email:parseEmail(h.from), subject:h.subject||'(no subject)', date:h.date||'', ts, snippet:(m.snippet||'').replace(/&#39;/g,"'").replace(/&amp;/g,'&') };
      if(!byThread[t] || ts>byThread[t].ts) byThread[t]=item;
    }
    const threads = Object.values(byThread).sort((x,y)=>y.ts-x.ts);
    return json(200, { threads, mailbox: at.email });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
