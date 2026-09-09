// Scans recently-dispatched Shopify orders, checks each tracking number against the courier
// (eShip/Starshipit) and flags any that did NOT get delivered (lost / damaged / destroyed /
// returned / uncollected / stuck). Captures dispatch date, order #, name, value, product
// types, suburb and service type, and looks up a likely replacement order.
const { gql } = require('./_shopify');
const { track } = require('./_eship');
const { rest } = require('./_appsdb');

function daysAgoISO(n){ const d=new Date(); d.setUTCDate(d.getUTCDate()-n); return d.toISOString().slice(0,10); }
function daysBetween(a,b){ return Math.round((new Date(b)-new Date(a))/86400000); }

const ORDER_Q = `query($q:String!,$after:String){ orders(first:20, query:$q, after:$after){ pageInfo{ hasNextPage endCursor } edges { node {
  name createdAt displayFulfillmentStatus
  totalPriceSet{ shopMoney{ amount } }
  customer{ firstName lastName email }
  shippingAddress{ name city province address2 }
  tags
  lineItems(first:15){ edges { node { title quantity product{ productType } } } }
  fulfillments(first:10){ createdAt trackingInfo{ number company } }
} } } }`;

// Terminal "not delivered" signals in a courier status / event text.
function troubleReason(hay){
  if(/destroy|dispos/i.test(hay)) return 'Destroyed';
  if(/lost|missing/i.test(hay)) return 'Lost in transit';
  if(/damag/i.test(hay)) return 'Damaged';
  if(/return to sender|returned|\brts\b/i.test(hay)) return 'Returned to sender';
  if(/refus/i.test(hay)) return 'Refused';
  if(/uncollected|not collected|abandon/i.test(hay)) return 'Uncollected';
  if(/undeliver|unable to deliver|not delivered|delivery failed|failed delivery|attempted|card (to call|left)/i.test(hay)) return 'Delivery failed';
  if(/seiz|held|detained/i.test(hay)) return 'Held';
  if(/exception|problem|error/i.test(hay)) return 'Exception';
  return '';
}

function lineNodes(order){ return ((order.lineItems && order.lineItems.edges) || []).map(e=>e.node); }
function serviceType(order, t){
  const hay=((order.tags||[]).join(' ')+' '+lineNodes(order).map(li=>li.title||'').join(' ')).toLowerCase();
  if(/perishable|chilled|frozen|cold|fresh|refriger/.test(hay)) return 'Perishable';
  return (t && t.service) || 'Standard';
}
function productTypes(order){
  const ln=lineNodes(order);
  const t=[...new Set(ln.map(li=>li.product && li.product.productType).filter(Boolean))];
  if(t.length) return t.join(', ');
  return [...new Set(ln.map(li=>(li.title||'').split(/\s+/)[0]).filter(Boolean))].slice(0,3).join(', ');
}

async function findReplacement(email, origName, origDate){
  if(!email) return '';
  try{
    const d=await gql(`query($q:String!){ orders(first:10, query:$q, sortKey:CREATED_AT, reverse:true){ edges{ node{ name createdAt totalPriceSet{ shopMoney{ amount } } tags note } } } }`, { q:'email:'+email });
    const cands=((d.orders&&d.orders.edges)||[]).map(e=>e.node).filter(n=>n.name!==origName && new Date(n.createdAt)>=new Date(origDate));
    const re=new RegExp('resend|replace|redo|re-?ship|'+String(origName).replace('#','#?'),'i');
    const pick=cands.find(n=>Number((n.totalPriceSet&&n.totalPriceSet.shopMoney&&n.totalPriceSet.shopMoney.amount)||0)===0)
            || cands.find(n=>re.test((n.note||'')+' '+((n.tags||[]).join(' '))));
    return pick? pick.name : '';
  }catch(e){ return ''; }
}

async function upsertNaughty(row){
  const ex=await rest('naughty_orders?status=neq.resolved&order_name=eq.'+encodeURIComponent(row.order_name)+'&select=id&limit=1').catch(()=>null);
  if(ex && ex.length){
    await rest('naughty_orders?id=eq.'+ex[0].id,{ method:'PATCH', headers:{Prefer:'return=minimal'}, body:JSON.stringify({ ...row, updated_at:new Date().toISOString() }) });
    return 'updated';
  }
  await rest('naughty_orders',{ method:'POST', headers:{Prefer:'return=minimal'}, body:JSON.stringify(row) });
  return 'inserted';
}

async function runScan(opts={}){
  const days = Number(opts.days)||35;
  const q = 'created_at:>='+daysAgoISO(days)+' -fulfillment_status:unfulfilled';
  await rest('naughty_scan?id=eq.1',{ method:'PATCH', headers:{Prefer:'return=minimal'}, body:JSON.stringify({ status:'running', updated_at:new Date().toISOString() }) }).catch(()=>{});

  const statuses={}; const samples=[]; let scanned=0, tracked=0, flagged=0;
  let after=null, pages=0;
  while(pages<8){
    const d=await gql(ORDER_Q, { q, after });
    const conn=d.orders; const edges=(conn&&conn.edges)||[];
    for(const e of edges){
      const o=e.node; scanned++;
      // earliest fulfillment with a tracking number
      let tn='', desp='';
      for(const f of (o.fulfillments||[])){ const ti=(f.trackingInfo||[]).find(x=>x.number); if(ti){ tn=ti.number; desp=f.createdAt; break; } }
      if(!tn) continue;
      tracked++;
      const t=await track({ trackingNumber: tn });
      const status = t.ok ? (t.status||'Unknown') : 'lookup failed';
      statuses[status]=(statuses[status]||0)+1;
      const eventsText=(t.events||[]).map(ev=>(ev.status||'')+' '+(ev.detail||'')).join(' | ');
      const hay=(status+' '+eventsText);
      const delivered = /deliver(ed)?/i.test(status) && !troubleReason(status);
      let reason='', detail='';
      if(!delivered){
        reason = troubleReason(hay);
        if(reason){ detail = eventsText.slice(0,240); }
        else if(desp && daysBetween(desp, new Date().toISOString())>12){ reason='No scan / stuck ('+daysBetween(desp, new Date().toISOString())+'d)'; detail=eventsText.slice(0,240); }
      }
      if(samples.length<25) samples.push({ order:o.name, status, flagged: !!reason, reason: reason||null });
      if(!reason){ await sleep(350); continue; }

      flagged++;
      const email=(o.customer&&o.customer.email)||'';
      const name=(o.shippingAddress&&o.shippingAddress.name)|| (o.customer? [o.customer.firstName,o.customer.lastName].filter(Boolean).join(' '):'');
      const suburb=(o.shippingAddress&&(o.shippingAddress.address2||o.shippingAddress.city))||'';
      const value=Number(o.totalPriceSet&&o.totalPriceSet.shopMoney&&o.totalPriceSet.shopMoney.amount)||null;
      const replacement=await findReplacement(email, o.name, o.createdAt);
      await upsertNaughty({
        order_name:o.name, tracking_number:tn, customer_name:name, customer_email:email,
        value, flag_reason:reason, source:'courier-scan', courier_status:status, courier_detail:detail,
        despatch_date: desp? desp.slice(0,10): null, product_types: productTypes(o), suburb,
        service_type: serviceType(o,t), resend_order: replacement, status:'open',
      });
      await sleep(400);
    }
    pages++;
    if(!conn||!conn.pageInfo||!conn.pageInfo.hasNextPage) break;
    after=conn.pageInfo.endCursor;
  }

  const topStatuses=Object.entries(statuses).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({status:k,count:v}));
  await rest('naughty_scan?id=eq.1',{ method:'PATCH', headers:{Prefer:'return=minimal'}, body:JSON.stringify({
    status:'idle', last_run:new Date().toISOString(), scanned, tracked, flagged,
    summary:{ statuses:topStatuses, samples }, updated_at:new Date().toISOString() }) }).catch(()=>{});
  return { scanned, tracked, flagged, statuses:topStatuses };
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

module.exports = { runScan };
