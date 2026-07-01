// Returns recent INBOUND messages (for matching replies to stores). Portal-gated (sales).
const { json, validatePortalUser } = require('./_portal');
const { getAccessToken } = require('./_gmail');
async function gapi(token, path){ const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{headers:{Authorization:'Bearer '+token}}); return r.json().catch(()=>({})); }
function parseEmail(from){ const m=(from||'').match(/<([^>]+)>/); return (m?m[1]:(from||'')).trim().toLowerCase(); }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'sales');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  const at = await getAccessToken();
  if (!at.ok) return json(400, { error: at.error });

  const list = await gapi(at.access_token, 'messages?maxResults=40&q=' + encodeURIComponent('in:inbox newer_than:90d'));
  const ids = (list.messages || []).map(m => m.id).slice(0, 40);
  const out = [];
  for (const id of ids) {
    const m = await gapi(at.access_token, 'messages/' + id + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date');
    const h = {}; ((m.payload && m.payload.headers) || []).forEach(x => h[x.name.toLowerCase()] = x.value);
    out.push({ id: m.id, threadId: m.threadId, from: h.from, email: parseEmail(h.from), subject: h.subject, snippet: m.snippet, date: h.date });
  }
  return json(200, { messages: out });
};
