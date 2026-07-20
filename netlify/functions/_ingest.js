// Shared inbox sync: pulls new cafe@ threads into tickets AND reconciles (auto-resolves
// tickets whose thread has left the inbox — e.g. archived directly in Gmail).
const { getAccessToken } = require('./_gmail');
const { rest, upsert } = require('./_appsdb');
const { gql } = require('./_shopify');

const MAILBOX = 'cafe@revive.co.nz';
const ORDER_RE = /\b(?:WEB\d{3,}|#\s?\d{3,}|order\s+#?\d{3,})\b/i;
function classifyType(isOrder, fromAddr, blob){
  if(isOrder) return 'order';
  const f=(fromAddr||'').toLowerCase();
  if(/(no-?reply|noreply|do-?not-?reply|donotreply|notification|mailer|newsletter|mailchimp|klaviyo|updates@|marketing@|team@)/.test(f)) return 'misc';
  if(/unsubscribe|view (this )?(email )?in (your )?browser|newsletter|©|to stop receiving/i.test(blob||'')) return 'misc';
  if(((blob||'').trim().length) < 15) return 'unknown';
  return 'enquiry';
}
function matchOrderRef(txt){
  let m=(txt||'').match(/\b(WEB\d{3,})\b/i); if(m) return m[1].toUpperCase();
  m=(txt||'').match(/#\s?(\d{3,})\b/); if(m) return '#'+m[1];
  m=(txt||'').match(/\border\s+#?(\d{3,})\b/i); if(m) return '#'+m[1];
  return null;
}
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

const infoCache={};
async function customerOrderInfo(email){
  if(!email || email.endsWith('@no-email.local')) return { known:false, latestOrder:null, count:null };
  if(email in infoCache) return infoCache[email];
  let info={ known:false, latestOrder:null, count:null };
  try{
    const d=await gql('query($q:String!){ orders(first:1, query:$q, sortKey:CREATED_AT, reverse:true){ edges { node { name } } } customers(first:1, query:$q){ edges { node { id numberOfOrders } } } }', { q:'email:'+email });
    const on=(d.orders&&d.orders.edges&&d.orders.edges[0]&&d.orders.edges[0].node.name)||null;
    const cnode=(d.customers&&d.customers.edges&&d.customers.edges[0]&&d.customers.edges[0].node)||null;
    info={ known: !!cnode || !!on, latestOrder: on, count: cnode ? Number(cnode.numberOfOrders||0) : null };
  }catch(e){}
  infoCache[email]=info; return info;
}

async function processThread(token, tid){
  const thread=await gapi(token,'threads/'+tid+'?format=full');
  const msgs=thread.messages||[]; if(!msgs.length) return { messages:0 };
  let custEmail='', custName='', subject='', blob='';
  const parsed=msgs.map(m=>{ const h={}; ((m.payload&&m.payload.headers)||[]).forEach(x=>h[x.name.toLowerCase()]=x.value);
    const bodyText=extractBody(m.payload); if(!subject && h.subject) subject=h.subject;
    blob+=' '+(h.subject||'')+' '+bodyText.slice(0,500);
    return { m, h, from:parseEmail(h.from), to:parseEmail(h.to), bodyText }; });
  for(const pm of parsed){ const other=pm.from&&pm.from!==MAILBOX?pm.from:(pm.to&&pm.to!==MAILBOX?pm.to:''); if(other&&!custEmail){ custEmail=other; custName=parseName(pm.h.from)||parseName(pm.h.to)||''; } }
  if(!custEmail) custEmail='unknown@no-email.local';
  const custRows=await upsert('customers',{ email:custEmail, name:custName||null, first_seen:new Date(Number(msgs[0].internalDate||Date.now())).toISOString() },'email');
  const customerId=custRows&&custRows[0]&&custRows[0].id;
  const lastTs=new Date(Number(msgs[msgs.length-1].internalDate||Date.now())).toISOString();
  const subj=(subject||'(no subject)').slice(0,300);
  const firstInbound=parsed.find(pm=>pm.from!==MAILBOX)||parsed[0];
  const snippet=((firstInbound&&firstInbound.bodyText)||'').replace(/\s+/g,' ').trim().slice(0,180);
  const info=await customerOrderInfo(custEmail);
  const matchedOrder=matchOrderRef(blob)||info.latestOrder||null;
  if(customerId&&info.count!=null){ try{ await rest('customers?id=eq.'+customerId,{ method:'PATCH', headers:{Prefer:'return=minimal'}, body:JSON.stringify({ orders_count:info.count }) }); }catch(e){} }
  const existing=await rest('tickets?gmail_thread_id=eq.'+encodeURIComponent(tid)+'&select=id&limit=1');
  let ticketId, created=false, triage='order';
  if(existing&&existing.length){
    ticketId=existing[0].id;
    await rest('tickets?id=eq.'+ticketId,{ method:'PATCH', headers:{Prefer:'return=minimal'}, body:JSON.stringify({ subject:subj, snippet, matched_order:matchedOrder, updated_at:lastTs }) });
  } else {
    const isOrder=ORDER_RE.test(blob)||info.known; triage=isOrder?'order':'non_order';
    const ins=await rest('tickets',{ method:'POST', headers:{Prefer:'return=representation'}, body:JSON.stringify({ gmail_thread_id:tid, customer_id:customerId, subject:subj, status:'Open', triage, ticket_type:classifyType(isOrder,custEmail,blob), source:'email', reviewed:false, matched_order:matchedOrder, snippet, updated_at:lastTs }) });
    ticketId=ins&&ins[0]&&ins[0].id; created=true;
  }
  await Promise.all(parsed.map(pm=>upsert('messages',{ gmail_message_id:pm.m.id, ticket_id:ticketId, direction:pm.from===MAILBOX?'outbound':'inbound', from_addr:pm.h.from||'', to_addr:pm.h.to||'', body:(pm.bodyText||'').slice(0,20000), sent_at:new Date(Number(pm.m.internalDate||Date.now())).toISOString() },'gmail_message_id')));
  return { messages:parsed.length, created, triage };
}

async function runInboxSync(opts){
  opts = opts || {};
  const at=await getAccessToken('cafe');
  if(!at.ok) return { ok:false, error:at.error, connected:false };
  const token=at.access_token;
  const q=opts.q||'in:inbox -category:promotions -category:social';
  const maxThreads=Math.min(Number(opts.max)||18,30);

  // Full set of inbox thread ids (for reconcile), newest-first ordered list (for processing).
  const seen=new Set(); const ordered=[]; let pageToken=null, pages=0, complete=true;
  do {
    const path='messages?maxResults=100&q='+encodeURIComponent(q)+(pageToken?('&pageToken='+pageToken):'');
    const list=await gapi(token, path);
    (list.messages||[]).forEach(m=>{ if(!seen.has(m.threadId)){ seen.add(m.threadId); ordered.push(m.threadId); } });
    pageToken=list.nextPageToken; pages++;
    if(pageToken && pages>=6){ complete=false; break; }
  } while(pageToken);

  const newest=ordered.slice(0, maxThreads);
  let order=0, nonOrder=0, messages=0;
  const CHUNK=4;
  for(let i=0;i<newest.length;i+=CHUNK){
    const res=await Promise.all(newest.slice(i,i+CHUNK).map(tid=>processThread(token,tid)));
    for(const r of res){ messages+=r.messages||0; if(r.created){ if(r.triage==='order') order++; else nonOrder++; } }
  }

  // Reconcile: resolve open email tickets whose thread is no longer in the inbox.
  let resolved=0;
  if(complete){
    const openTix=await rest("tickets?status=neq.Resolved&gmail_thread_id=not.is.null&source=eq.email&select=id,gmail_thread_id&limit=1000");
    const toResolve=(openTix||[]).filter(t=>!seen.has(t.gmail_thread_id)).map(t=>t.id);
    if(toResolve.length){
      const idList=toResolve.map(id=>'"'+id+'"').join(',');
      await rest('tickets?id=in.('+idList+')',{ method:'PATCH', headers:{Prefer:'return=minimal'}, body:JSON.stringify({ status:'Resolved', resolved_at:new Date().toISOString(), updated_at:new Date().toISOString() }) });
      resolved=toResolve.length;
    }
  }
  return { ok:true, threads:newest.length, order, nonOrder, messages, resolved, reconciled:complete };
}

module.exports = { runInboxSync };
