// Pulls recent cafe@ threads → support.customers/tickets/messages, classifying each
// new thread as 'order' (known Shopify customer or order-number) or 'non_order'.
// Portal-gated (support). Server-side only.
const { json, validatePortalUser } = require('./_portal');
const { getAccessToken } = require('./_gmail');
const { rest, upsert, hasKey } = require('./_appsdb');
const { gql } = require('./_shopify');

const MAILBOX = 'cafe@revive.co.nz';
const ORDER_RE = /\b(?:WEB\d{3,}|#\s?\d{3,}|order\s+#?\d{3,})\b/i;

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

const knownCache = {};
async function isKnownCustomer(email){
  if(!email || email.endsWith('@no-email.local')) return false;
  if(email in knownCache) return knownCache[email];
  let known=false;
  try{ const d=await gql('query($q:String!){ customers(first:1, query:$q){ edges { node { id } } } }', { q:'email:'+email });
    known=((d.customers&&d.customers.edges)||[]).length>0; }catch(e){ known=false; }
  knownCache[email]=known; return known;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Ticket database not configured yet (APPS_SERVICE_ROLE_KEY missing in Netlify).' });

  const at = await getAccessToken('cafe');
  if (!at.ok) return json(400, { error: at.error, connected: false });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  // Skip Gmail's promo/social buckets and spam by default.
  const q = body.q || 'in:inbox -category:promotions -category:social newer_than:60d';
  const maxThreads = Math.min(Number(body.max) || 25, 40);

  const list = await gapi(at.access_token, 'messages?maxResults=80&q=' + encodeURIComponent(q));
  const threadIds = [...new Set((list.messages || []).map(m => m.threadId))].slice(0, maxThreads);

  let orderN = 0, nonOrderN = 0, mCount = 0, newT = 0;
  const custCache = {};

  for (const tid of threadIds) {
    const thread = await gapi(at.access_token, 'threads/' + tid + '?format=full');
    const msgs = thread.messages || [];
    if (!msgs.length) continue;

    let custEmail = '', custName = '', subject = '', blob = '';
    const parsed = msgs.map(m => {
      const h = {}; ((m.payload && m.payload.headers) || []).forEach(x => h[x.name.toLowerCase()] = x.value);
      const bodyText = extractBody(m.payload);
      if (!subject && h.subject) subject = h.subject;
      blob += ' ' + (h.subject || '') + ' ' + bodyText.slice(0, 500);
      return { m, h, from: parseEmail(h.from), to: parseEmail(h.to), bodyText };
    });
    for (const pm of parsed) {
      const other = pm.from && pm.from !== MAILBOX ? pm.from : (pm.to && pm.to !== MAILBOX ? pm.to : '');
      if (other && !custEmail) { custEmail = other; custName = parseName(pm.h.from) || parseName(pm.h.to) || ''; }
    }
    if (!custEmail) custEmail = 'unknown@no-email.local';

    let customerId = custCache[custEmail];
    if (!customerId) {
      const rows = await upsert('customers', { email: custEmail, name: custName || null, first_seen: new Date(Number(msgs[0].internalDate||Date.now())).toISOString() }, 'email');
      customerId = rows && rows[0] && rows[0].id; custCache[custEmail] = customerId;
    }

    const lastTs = new Date(Number(msgs[msgs.length-1].internalDate || Date.now())).toISOString();
    const subj = (subject || '(no subject)').slice(0, 300);

    // Get-or-insert ticket (do NOT clobber triage/reviewed on re-sync).
    const existing = await rest('tickets?gmail_thread_id=eq.' + encodeURIComponent(tid) + '&select=id&limit=1');
    let ticketId;
    if (existing && existing.length) {
      ticketId = existing[0].id;
      await rest('tickets?id=eq.' + ticketId, { method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({ subject: subj, updated_at: lastTs }) });
    } else {
      const isOrder = ORDER_RE.test(blob) || await isKnownCustomer(custEmail);
      const triage = isOrder ? 'order' : 'non_order';
      const ins = await rest('tickets', { method:'POST', headers:{ Prefer:'return=representation' }, body: JSON.stringify({ gmail_thread_id: tid, customer_id: customerId, subject: subj, status:'Open', triage, reviewed:false, updated_at: lastTs }) });
      ticketId = ins && ins[0] && ins[0].id; newT++;
      if (triage === 'order') orderN++; else nonOrderN++;
    }

    for (const pm of parsed) {
      await upsert('messages', {
        gmail_message_id: pm.m.id, ticket_id: ticketId,
        direction: pm.from === MAILBOX ? 'outbound' : 'inbound',
        from_addr: pm.h.from || '', to_addr: pm.h.to || '',
        body: (pm.bodyText || '').slice(0, 20000),
        sent_at: new Date(Number(pm.m.internalDate || Date.now())).toISOString(),
      }, 'gmail_message_id');
      mCount++;
    }
  }

  return json(200, { ok:true, threads: threadIds.length, newTickets: newT, order: orderN, nonOrder: nonOrderN, messages: mCount });
};
