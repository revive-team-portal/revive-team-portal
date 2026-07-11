// Pulls recent cafe@ threads and upserts them into support.customers / tickets / messages.
// Portal-gated (support). Server-side only.
const { json, validatePortalUser } = require('./_portal');
const { getAccessToken } = require('./_gmail');
const { rest, upsert, hasKey } = require('./_appsdb');

const MAILBOX = 'cafe@revive.co.nz';
function b64(s){ return Buffer.from((s||'').replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'); }
function parseEmail(s){ const m=(s||'').match(/<([^>]+)>/); return (m?m[1]:(s||'')).trim().toLowerCase(); }
function parseName(s){ const m=(s||'').match(/^\s*"?([^"<]+?)"?\s*</); return m?m[1].trim():''; }
function extractBody(payload){
  if(!payload) return '';
  let plain='', html='';
  (function walk(p){ if(!p) return; if(p.parts) p.parts.forEach(walk);
    if(p.mimeType==='text/plain' && p.body && p.body.data) plain += b64(p.body.data);
    else if(p.mimeType==='text/html' && p.body && p.body.data) html += b64(p.body.data);
  })(payload);
  if(plain.trim()) return plain.trim();
  return html.replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
}
async function gapi(token, path){ const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{headers:{Authorization:'Bearer '+token}}); return r.json().catch(()=>({})); }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Ticket database not configured yet (APPS_SERVICE_ROLE_KEY missing in Netlify).' });

  const at = await getAccessToken('cafe');
  if (!at.ok) return json(400, { error: at.error, connected: false });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  const q = body.q || 'in:inbox newer_than:60d';
  const maxThreads = Math.min(Number(body.max) || 25, 40);

  const list = await gapi(at.access_token, 'messages?maxResults=60&q=' + encodeURIComponent(q));
  const threadIds = [...new Set((list.messages || []).map(m => m.threadId))].slice(0, maxThreads);

  let tCount = 0, mCount = 0, cCount = 0;
  const custCache = {};

  for (const tid of threadIds) {
    const thread = await gapi(at.access_token, 'threads/' + tid + '?format=full');
    const msgs = thread.messages || [];
    if (!msgs.length) continue;

    // Determine the customer (the non-cafe@ party) from the thread.
    let custEmail = '', custName = '', subject = '';
    for (const m of msgs) {
      const h = {}; ((m.payload && m.payload.headers) || []).forEach(x => h[x.name.toLowerCase()] = x.value);
      if (!subject && h.subject) subject = h.subject;
      const from = parseEmail(h.from), to = parseEmail(h.to);
      const other = from && from !== MAILBOX ? from : (to && to !== MAILBOX ? to : '');
      if (other && !custEmail) { custEmail = other; custName = parseName(h.from) || parseName(h.to) || ''; }
    }
    if (!custEmail) custEmail = 'unknown@no-email.local';

    // Upsert customer.
    let customerId = custCache[custEmail];
    if (!customerId) {
      const rows = await upsert('customers', { email: custEmail, name: custName || null, first_seen: new Date(Number(msgs[0].internalDate||Date.now())).toISOString() }, 'email');
      customerId = rows && rows[0] && rows[0].id;
      custCache[custEmail] = customerId; cCount++;
    }

    // Upsert ticket by gmail_thread_id.
    const last = msgs[msgs.length - 1];
    const trow = await upsert('tickets', {
      gmail_thread_id: tid, customer_id: customerId, subject: (subject || '(no subject)').slice(0, 300),
      status: 'Open', updated_at: new Date(Number(last.internalDate || Date.now())).toISOString(),
    }, 'gmail_thread_id');
    const ticketId = trow && trow[0] && trow[0].id;
    tCount++;

    // Upsert each message.
    for (const m of msgs) {
      const h = {}; ((m.payload && m.payload.headers) || []).forEach(x => h[x.name.toLowerCase()] = x.value);
      const from = parseEmail(h.from);
      await upsert('messages', {
        gmail_message_id: m.id, ticket_id: ticketId,
        direction: from === MAILBOX ? 'outbound' : 'inbound',
        from_addr: h.from || '', to_addr: h.to || '',
        body: extractBody(m.payload).slice(0, 20000),
        sent_at: new Date(Number(m.internalDate || Date.now())).toISOString(),
      }, 'gmail_message_id');
      mCount++;
    }
  }

  return json(200, { ok: true, threads: threadIds.length, tickets: tCount, messages: mCount, customers: cCount });
};
