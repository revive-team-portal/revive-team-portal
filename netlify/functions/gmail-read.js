// Reads recent Gmail messages to/from a contact (or one full message). Portal-gated (sales).
const { json, validatePortalUser } = require('./_portal');
const { getAccessToken } = require('./_gmail');

async function gapi(token, path) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { headers: { Authorization: 'Bearer ' + token } });
  return r.json().catch(() => ({}));
}
function decode(data){ try { return Buffer.from((data||'').replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8'); } catch { return ''; } }
function extractBody(payload){
  function walk(p){ if(!p) return ''; if(p.mimeType==='text/plain' && p.body && p.body.data) return decode(p.body.data);
    if(p.parts){ for(const c of p.parts){ const r=walk(c); if(r) return r; } } return ''; }
  return walk(payload);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'sales');
  if (!a.ok) return json(a.status || 403, { error: a.error });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }
  const at = await getAccessToken();
  if (!at.ok) return json(400, { error: at.error });

  if (body.messageId) {
    const m = await gapi(at.access_token, 'messages/' + body.messageId + '?format=full');
    return json(200, { id: m.id, text: extractBody(m.payload) || m.snippet || '' });
  }

  let emails = Array.isArray(body.emails) ? body.emails : (body.email ? [body.email] : []);
  emails = [...new Set(emails.map(e => (e || '').trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) return json(400, { error: 'No contact email.' });
  const q = encodeURIComponent(emails.map(e => 'from:' + e + ' OR to:' + e).join(' OR '));
  const list = await gapi(at.access_token, 'messages?maxResults=' + (Number(body.max) || 12) + '&q=' + q);
  const ids = (list.messages || []).map(m => m.id).slice(0, 12);
  const out = [];
  for (const id of ids) {
    const m = await gapi(at.access_token, 'messages/' + id + '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date');
    const h = {}; ((m.payload && m.payload.headers) || []).forEach(x => h[x.name.toLowerCase()] = x.value);
    const fromMe = (h.from || '').toLowerCase().includes((at.email || '').toLowerCase());
    out.push({ id: m.id, threadId: m.threadId, direction: fromMe ? 'out' : 'in', from: h.from, to: h.to, subject: h.subject, date: h.date, snippet: m.snippet });
  }
  out.sort((x, y) => new Date(y.date) - new Date(x.date));
  return json(200, { messages: out });
};
