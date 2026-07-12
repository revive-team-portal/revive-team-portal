// Drafts a reply using Claude, grounded in the thread, internal notes, Shopify orders,
// and the REAL eShip/NZ Post courier status. Tone + sign-off driven by editable Settings.
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
const { gql } = require('./_shopify');
const { track } = require('./_eship');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function fmt(v){ const d=v?new Date(v):null; return (d&&!isNaN(d))?d.toLocaleString('en-NZ',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):(v||''); }
async function loadSettings(){ try{ const rows=await rest('settings?select=key,value'); const m={}; (rows||[]).forEach(r=>m[r.key]=r.value); return m; }catch(e){ return {}; } }

async function orderAndCourier(email){
  if(!email || email.endsWith('@no-email.local')) return { ordersText:'No customer email on file.', courierText:'' };
  let orders=[];
  try{
    const d = await gql('query($q:String!){ orders(first:5, query:$q, sortKey:CREATED_AT, reverse:true){ edges { node { name displayFinancialStatus displayFulfillmentStatus createdAt fulfillments(first:3){ trackingInfo{ number company } } } } } }', { q:'email:'+email });
    orders = (d.orders&&d.orders.edges||[]).map(e=>e.node);
  }catch(e){ return { ordersText:'Order lookup unavailable.', courierText:'' }; }
  if(!orders.length) return { ordersText:'No Shopify orders found for this customer.', courierText:'' };
  const ordersText = orders.map(o=>{
    const tn=(o.fulfillments||[]).flatMap(f=>(f.trackingInfo||[]).map(t=>t.number)).filter(Boolean);
    return `Order ${o.name} — Shopify says ${o.displayFinancialStatus||'?'}/${o.displayFulfillmentStatus||'?'}, placed ${new Date(o.createdAt).toLocaleDateString('en-NZ')}${tn.length?', tracking '+tn.join(', '):''}`;
  }).join('\n');
  const courierLines=[]; let checked=0;
  for(const o of orders){
    const tn=(o.fulfillments||[]).flatMap(f=>(f.trackingInfo||[]).map(t=>t.number)).filter(Boolean)[0];
    if(tn && checked<2){ checked++;
      const tr=await track({ trackingNumber:tn });
      if(tr.ok){ const scans=tr.events.slice(0,4).map(e=>`${fmt(e.date)}: ${e.detail||e.status}${e.location?' ('+e.location+')':''}`).join(' | ');
        courierLines.push(`Order ${o.name} [${tn}] — COURIER STATUS: ${tr.status}${tr.deliveredDate?', delivered '+fmt(tr.deliveredDate):''}${tr.signedBy?', signed by '+tr.signedBy:''}. Recent scans: ${scans||'none'}`);
      } else courierLines.push(`Order ${o.name} [${tn}] — courier status unavailable (${tr.error}).`);
    }
  }
  return { ordersText, courierText: courierLines.join('\n') || 'No live courier tracking available.' };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!ANTHROPIC_KEY) return json(500, { error: 'AI not configured (ANTHROPIC_API_KEY).' });
  if (!hasKey()) return json(500, { error: 'Ticket database not configured.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }
  if (!body.id) return json(400, { error: 'No ticket id.' });

  try {
    const settings = await loadSettings();
    const tone = settings.ai_tone_prompt || 'Write in a warm, friendly, helpful New Zealand voice.';
    const operator = (body.operatorName || '').trim() || 'the team member';

    const t = await rest('tickets?id=eq.'+encodeURIComponent(body.id)+'&select=*,customer:customers(*)&limit=1');
    if (!t || !t.length) return json(404, { error: 'Ticket not found.' });
    const ticket = t[0]; const cust = ticket.customer || {};
    const [msgs, notes] = await Promise.all([
      rest('messages?ticket_id=eq.'+encodeURIComponent(body.id)+'&select=direction,from_addr,body,sent_at&order=sent_at.asc'),
      rest('notes?ticket_id=eq.'+encodeURIComponent(body.id)+'&select=body,type,author,created_at&order=created_at.asc'),
    ]);
    const convo = (msgs||[]).map(m => (m.direction==='outbound'?'Revive':'Customer')+' ('+fmt(m.sent_at)+'): '+(m.body||'').slice(0,1500)).join('\n\n');
    const notesText = (notes||[]).length ? notes.map(n=>`- [${n.type||'note'}, ${n.author||'staff'}] ${n.body}`).join('\n') : 'None.';
    const { ordersText, courierText } = await orderAndCourier(cust.email);

    const prompt = `You are drafting a reply for the Revive Café / Revivealicious Foods customer service inbox (a New Zealand gluten-free food company). Reply to the customer's most recent message in New Zealand English.

TONE & STYLE (follow this closely):
${tone}

The operator sending this reply is "${operator}". Sign off using their first name. Do NOT sign as "The Revive Team".

Reasoning with the facts:
- The COURIER STATUS below is the source of truth for where a parcel is — trust it over the Shopify fulfilment field, which is often stale. If the customer asks where their order is and the courier shows delivered, tell them clearly (with date and who signed, if available); if in transit or out for delivery, say so specifically.
- Use INTERNAL STAFF NOTES for context and any actions already taken — never quote them verbatim to the customer.
- NEVER invent tracking numbers, delivery dates, refund amounts, or promises. If the facts don't answer the question, say you're looking into it or ask a clarifying question.
- Return only the reply body — no subject line or headers, and do NOT add a footer/signature block (one is appended automatically).

Customer: ${cust.name||''} <${cust.email||'unknown'}>
Ticket: ${ticket.subject||''} (status ${ticket.status||''})

ORDERS (Shopify):
${ordersText}

COURIER STATUS (eShip / NZ Post — source of truth):
${courierText}

INTERNAL STAFF NOTES (context only, do not quote to customer):
${notesText}

CONVERSATION SO FAR:
${convo || '(no prior messages)'}

Draft the next reply from cafe@revive.co.nz, signing off as ${operator}:`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:1024, messages:[{ role:'user', content:prompt }] }),
    });
    const d = await res.json().catch(()=>({}));
    if (!res.ok) return json(502, { error: (d&&d.error&&d.error.message)||'AI request failed.' });
    const text = (d.content && d.content[0] && d.content[0].text) || '';
    return json(200, { draft: text, footer: settings.reply_footer || '' });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
