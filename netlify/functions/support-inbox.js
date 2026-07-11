// Live view of the cafe@ support inbox (grouped by thread). Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { getAccessToken } = require('./_gmail');

async function gapi(token, path){ const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{headers:{Authorization:'Bearer '+token}}); return r.json().catch(()=>({})); }
function parseEmail(from){ const m=(from||'').match(/<([^>]+)>/); return (m?m[1]:(from||'')).trim().toLowerCase(); }
function parseName(from){ const m=(from||'').match(/^\s*"?([^"<]+?)"?\s*</); return m?m[1].trim():''; }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  const at = await getAccessToken('cafe');
  if (!at.ok) return json(400, { error: at.error, connected: false });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  const q = body.q || 'in:inbox newer_than:60d';
  const list = await gapi(at.access_token, 'messages?maxResults=50&q=' + encodeURIComponent(q));
  const ids = (list.messages || []).map(m => m.id).slice(0, 50);

  const byThread = {};
  for (const id of ids) {
    const m = await gapi(at.access_token, 'messages/' + id + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date');
    const h = {}; ((m.payload && m.payload.headers) || []).forEach(x => h[x.name.toLowerCase()] = x.value);
    const t = m.threadId;
    const item = {
      id: m.id, threadId: t, from: h.from, name: parseName(h.from), email: parseEmail(h.from),
      subject: h.subject || '(no subject)', snippet: (m.snippet || '').replace(/&#39;/g,"'").replace(/&amp;/g,'&').replace(/&quot;/g,'"'),
      date: h.date, ts: Number(m.internalDate || 0), unread: (m.labelIds || []).includes('UNREAD'),
    };
    if (!byThread[t] || item.ts > byThread[t].ts) byThread[t] = { ...item, count: (byThread[t]?.count || 0) + 1, unread: item.unread || (byThread[t]?.unread) };
    else byThread[t].count = (byThread[t].count || 1) + 1;
  }
  const threads = Object.values(byThread).sort((x, y) => y.ts - x.ts);
  return json(200, { connected: true, mailbox: at.email, threads });
};
