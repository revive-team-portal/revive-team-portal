// Support KPIs: tickets outstanding, open orders, first-response/resolution/replies (DB),
// and fulfilment time (Shopify). Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
const { gql } = require('./_shopify');

function median(a){ if(!a.length) return null; const s=a.slice().sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function hrs(ms){ return ms/3600000; }
function fmtDur(h){ if(h==null) return '—'; if(h<1) return Math.round(h*60)+' min'; if(h<48) return (Math.round(h*10)/10)+' h'; return (Math.round(h/24*10)/10)+' d'; }

exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  try {
    const tickets = await rest('tickets?select=id,created_at,resolved_at,status,messages(direction,sent_at)&limit=3000');
    let outstanding=0; const frt=[], reso=[], replies=[];
    for (const t of (tickets||[])) {
      if (t.status !== 'Resolved') outstanding++;
      const ms = t.messages || [];
      const ins = ms.filter(m=>m.direction==='inbound' && m.sent_at).map(m=>new Date(m.sent_at).getTime()).sort((x,y)=>x-y);
      const outs = ms.filter(m=>m.direction==='outbound' && m.sent_at).map(m=>new Date(m.sent_at).getTime()).sort((x,y)=>x-y);
      if (ins.length && outs.length) { const fo = outs.find(o=>o>=ins[0]); if (fo) frt.push(hrs(fo-ins[0])); }
      replies.push(ms.length);
      if (t.resolved_at && t.created_at) reso.push(hrs(new Date(t.resolved_at)-new Date(t.created_at)));
    }
    const ticketCount = (tickets||[]).length;

    // Shopify: open orders (unfulfilled) + fulfilment time
    let openOrders=0, openCapped=false;
    try {
      let after=null, pages=0;
      while (pages<3) { const d=await gql('query($q:String!,$after:String){ orders(first:100, query:$q, after:$after){ pageInfo{ hasNextPage endCursor } edges{ node{ id } } } }', { q:'fulfillment_status:unfulfilled status:open', after });
        const c=d.orders; openOrders += (c.edges||[]).length; pages++;
        if(!c.pageInfo.hasNextPage){ break; } after=c.pageInfo.endCursor; if(pages>=3 && c.pageInfo.hasNextPage) openCapped=true; }
    } catch(e){}
    const fulfil=[];
    try {
      const d=await gql('query{ orders(first:50, query:"fulfillment_status:fulfilled status:any", sortKey:CREATED_AT, reverse:true){ edges{ node{ createdAt fulfillments(first:1){ createdAt } } } } }');
      for (const e of (d.orders&&d.orders.edges||[])) { const o=e.node; const f=(o.fulfillments||[])[0]; if(o.createdAt && f && f.createdAt){ const h=hrs(new Date(f.createdAt)-new Date(o.createdAt)); if(h>=0 && h<24*60) fulfil.push(h); } }
    } catch(e){}

    return json(200, {
      ticketsOutstanding: outstanding,
      totalTickets: ticketCount,
      openOrders, openCapped,
      firstResponseH: median(frt), firstResponse: fmtDur(median(frt)), frtSample: frt.length,
      resolutionH: median(reso), resolution: fmtDur(median(reso)), resoSample: reso.length,
      repliesPerTicket: replies.length ? Math.round((replies.reduce((s,x)=>s+x,0)/replies.length)*10)/10 : null,
      fulfilmentH: median(fulfil), fulfilment: fmtDur(median(fulfil)), fulfilSample: fulfil.length,
    });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
