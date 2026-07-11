// Drafts a suggested reply for a ticket using Claude, grounded in the thread + order context.
// Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
const { gql } = require('./_shopify');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

async function orderContext(email){
  if(!email || email.endsWith('@no-email.local')) return '';
  try{
    const d = await gql('query($q:String!){ orders(first:5, query:$q, sortKey:CREATED_AT, reverse:true){ edges { node { name displayFinancialStatus displayFulfillmentStatus createdAt fulfillments(first:3){ trackingInfo{ number company url } } } } } }', { q:'email:'+email });
    const orders = (d.orders&&d.orders.edges||[]).map(e=>e.node);
    if(!orders.length) return 'No Shopify orders found for this customer.';
    return orders.map(o=>{
      const tr = (o.fulfillments||[]).flatMap(f=>(f.trackingInfo||[]).map(t=>`${t.company||''} ${t.number||''}`.trim())).filter(Boolean).join('; ');
      return `Order ${o.name} — ${o.displayFinancialStatus||'?'}/${o.displayFulfillmentStatus||'?'}, placed ${new Date(o.createdAt).toLocaleDateString('en-NZ')}${tr?', tracking: '+tr:''}`;
    }).join('\n');
  }catch(e){ return 'Order context unavailable.'; }
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
    const msgs = await rest('messages?ticket_id=eq.'+encodeURIComponent(body.id)+'&select=direction,from_addr,body,sent_at&order=sent_at.asc');

    const convo = (msgs||[]).map(m => (m.direction==='outbound'?'Revive':'Customer')+': '+(m.body||'').slice(0,1500)).join('\n\n');
    const orders = await orderContext(cust.email);

    const prompt = `You are drafting a reply for the Revive Cafe / Revivealicious Foods customer service inbox (a New Zealand gluten-free food company). Write a warm, concise, professional reply to the customer's most recent message, in New Zealand English.

Rules:
- Use the order context below where relevant, but NEVER invent tracking numbers, refund amounts, dates, or promises you cannot verify. If something isn't known, say you're looking into it or ask politely.
- Be genuinely helpful and empathetic; keep it brief.
- Sign off as "The Revive Team". Do not include a subject line or email headers — return only the reply body.

Customer: ${cust.name||''} <${cust.email||'unknown'}>
Ticket subject: ${ticket.subject||''}

Order context:
${orders}

Conversation so far:
${convo || '(no prior messages)'}

Draft the next reply from cafe@revive.co.nz:`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:1024, messages:[{ role:'user', content:prompt }] }),
    });
    const d = await res.json().catch(()=>({}));
    if (!res.ok) return json(502, { error: (d&&d.error&&d.error.message)||'AI request failed.' });
    const text = (d.content && d.content[0] && d.content[0].text) || '';
    return json(200, { draft: text, orderContext: orders });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
