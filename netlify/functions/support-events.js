// Merged activity timeline for a customer: emails, notes, phone/SMS interactions, and orders placed.
// Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
const { gql } = require('./_shopify');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }
  const cid = body.customerId; const email = (body.email||'').trim();

  const events = [];
  try {
    if (cid) {
      const tickets = await rest('tickets?customer_id=eq.'+encodeURIComponent(cid)+'&select=id');
      const ids = (tickets||[]).map(t=>t.id);
      if (ids.length) {
        const inlist = '(' + ids.join(',') + ')';
        const [msgs, notes] = await Promise.all([
          rest('messages?ticket_id=in.'+inlist+'&select=direction,from_addr,to_addr,sent_at,body&order=sent_at.desc&limit=100'),
          rest('notes?ticket_id=in.'+inlist+'&select=type,author,body,created_at&order=created_at.desc&limit=50'),
        ]);
        (msgs||[]).forEach(m => events.push({ type: m.direction==='outbound'?'email_out':'email_in', who: m.direction==='outbound'?'Revive':(m.from_addr||''), time: m.sent_at, text: (m.body||'').replace(/\s+/g,' ').slice(0,120) }));
        (notes||[]).forEach(n => events.push({ type:'note', who: n.author||'staff', time: n.created_at, text: n.body }));
      }
      const inter = await rest('interactions?customer_id=eq.'+encodeURIComponent(cid)+'&select=channel,direction,operator,note,occurred_at&order=occurred_at.desc&limit=50');
      (inter||[]).forEach(i => events.push({ type:'interaction', channel:i.channel, direction:i.direction, who:i.operator||'staff', time:i.occurred_at, text:i.note }));
    }
    if (email && !email.endsWith('@no-email.local')) {
      try {
        const d = await gql('query($q:String!){ orders(first:10, query:$q, sortKey:CREATED_AT, reverse:true){ edges { node { name createdAt totalPriceSet{ shopMoney{ amount currencyCode } } } } } }', { q:'email:'+email });
        (d.orders&&d.orders.edges||[]).forEach(e => { const o=e.node; events.push({ type:'order', who:'Customer', time:o.createdAt, text:'Placed order '+o.name+(o.totalPriceSet?(' · '+(o.totalPriceSet.shopMoney.currencyCode||'NZD')+' '+Number(o.totalPriceSet.shopMoney.amount).toFixed(2)):'') }); });
      } catch(e){}
    }
    events.sort((x,y)=> new Date(y.time) - new Date(x.time));
    return json(200, { events: events.slice(0, 60) });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
