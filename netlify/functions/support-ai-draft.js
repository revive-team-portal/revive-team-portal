// Drafts a reply using Claude, grounded in: the email thread, internal staff notes,
// the customer's Shopify orders, and the REAL eShip/NZ Post courier status. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
const { gql } = require('./_shopify');
const { track } = require('./_eship');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function fmt(v){ const d=v?new Date(v):null; return (d&&!isNaN(d))?d.toLocaleString('en-NZ',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):(v||''); }

// Returns { ordersText, courierText } for a customer email.
async function orderAndCourier(email){
  if(!email || email.endsWith('@no-email.local')) return { ordersText:'No customer email on file.', courierText:'' };
  let orders=[];
  try{
    const d = await gql('query($q:String!){ orders(first:5, query:$q, sortKey:CREATED_AT, reverse:true){ edges { node { name displayFinancialStatus displayFulfillmentStatus createdAt fulfillments(first:3){ trackingInfo{ number company } } } } } }', { q:'email:'+email });
    orders = (d.orders&&d.orders.edges||[]).map(e=>e.node);
  }catch(e){ return { ordersText:'Order lookup unavailable.', courierText:'' }; }
  if(!orders.length) return { ordersText:'No Shopify orders found for this customer.', courierText:'' };

  const ordersText = orders.map(o=>{
    const tn = (o.fulfillments||[]).flatMap(f=>(f.trackingInfo||[]).map(t=>t.number)).filter(Boolean);
    return `Order ${o.name} — Shopify says ${o.displayFinancialStatus||'?'}/${o.displayFulfillmentStatus||'?'}, placed ${new Date(o.createdAt).toLocaleDateString('en-NZ')}${tn.length?', tracking '+tn.join(', '):''}`;
  }).join('\n');

  // Real courier status for up to the 2 most recent orders that have a tracking number.
  const courierLines=[]; let checked=0;
  for(const o of orders){
    const tn = (o.fulfillments||[]).flatMap(f=>(f.trackingInfo||[]).map(t=>t.number)).filter(Boolean)[0];
    if(tn && checked<2){
      checked++;
      const tr = await track({ trackingNumber: tn });
      if(tr.ok){
        const scans = tr.events.slice(0,4).map(e=>`${fmt(e.date)}: ${e.detail||e.status}${e.location?' ('+e.location+')':''}`).join(' | ');
        courierLines.push(`Order ${o.name} [${tn}] — COURIER STATUS: ${tr.status}${tr.deliveredDate?', delivered '+fmt(tr.deliveredDate):''}${tr.signedBy?', signed by '+tr.signedBy:''}. Recent scans: ${scans||'none'}`);
      } else {
        courierLines.push(`Order ${o.name} [${tn}] — courier status unavailable (${tr.error}).`);
      }
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

    const prompt = `You are drafting a reply for the Revive Cafe / Revivealicious Foods customer service inbox (a New Zealand gluten-free food company). Write a warm, concise, professional reply to the customer's most recent message, in New Zealand English.

How to reason:
- The COURIER STATUS below is the source of truth for where a parcel is — trust it over the Shopify fulfilment field, which is often stale. If the customer is asking where their order is and the courier shows it delivered, tell them clearly (with the date and who signed, if available). If it's in transit or out for delivery, say so specifically.
- Use the INTERNAL STAFF NOTES for context and any actions already taken or promised — but never quote them verbatim or reveal internal wording to the customer.
- NEVER invent tracking numbers, delivery dates, refund amounts, or promises. If the facts don't answer the question, say you're looking into it or ask a clarifying question.
- Be genuinely helpful and empathetic; keep it brief. Sign off as "The Revive Team". Return only the reply body — no subject line or headers.

Customer: ${cust.name||''} <${cust.email||'unknown'}>
Ticket: ${ticket.subject||''} (status ${ticket.status||''}${ticket.category?', category '+ticket.category:''})

ORDERS (Shopify):
${ordersText}

COURIER STATUS (eShip / NZ Post — source of truth):
${courierText}

INTERNAL STAFF NOTES (context only, do not quote to customer):
${notesText}

CONVERSATION SO FAR:
${convo || '(no prior messages)'}

Draft the next reply from cafe@revive.co.nz:`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:1024, messages:[{ role:'user', content:prompt }] }),
    });
    const d = await res.json().catch(()=>({}));
    if (!res.ok) return json(502, { error: (d&&d.error&&d.error.message)||'AI request failed.' });
    const text = (d.content && d.content[0] && d.content[0].text) || '';
    return json(200, { draft: text, usedCourier: courierText, usedNotes: notesText !== 'None.' });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
