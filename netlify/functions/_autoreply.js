// Purge Klaviyo auto-replies (out-of-office bounces from Klaviyo blasts that reply-to cafe@).
// SAFE: only trashes a message that is BOTH an auto-reply AND references a Klaviyo-sent email.
const { rest } = require('./_appsdb');
async function gapi(token,path,opts){ const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{ ...(opts||{}), headers:{ Authorization:'Bearer '+token } }); return r.json().catch(()=>({})); }
function isKlaviyoAutoReply(h, snippet){
  const subj = h.subject || '';
  const autoReply = /auto-?replied|auto-?generated/i.test(h['auto-submitted']||'')
    || h['x-autoreply']!=null || h['x-autorespond']!=null || h['x-auto-response-suppress']!=null
    || /(auto_reply|auto-reply|list)/i.test(h['precedence']||'')
    || /^(re:\s*)?(automatic reply|auto[- ]?reply|out of office|out-of-office|away from|on leave|annual leave|on vacation|vacation|currently out|maternity leave|i am (currently )?(out|away|on))/i.test(subj);
  const refs = (h['references']||'')+' '+(h['in-reply-to']||'')+' '+(snippet||'');
  const klaviyo = /klaviyo/i.test(refs);
  return autoReply && klaviyo;
}
const HDRS = ['Subject','From','Auto-Submitted','X-Autoreply','X-Autorespond','X-Auto-Response-Suppress','Precedence','References','In-Reply-To'].map(x=>'metadataHeaders='+x).join('&');
async function runAutoReplyPurge(token){
  let after=null, pages=0, scanned=0, trashed=0; const trashThreads=new Set();
  do {
    const list=await gapi(token,'messages?maxResults=100&q='+encodeURIComponent('in:inbox newer_than:45d')+(after?('&pageToken='+after):''));
    const ids=(list.messages||[]).map(m=>m.id);
    for(let i=0;i<ids.length;i+=6){
      const b=await Promise.all(ids.slice(i,i+6).map(id=>gapi(token,'messages/'+id+'?format=metadata&'+HDRS)));
      for(const m of b){ scanned++; const h={}; ((m.payload&&m.payload.headers)||[]).forEach(x=>h[x.name.toLowerCase()]=x.value);
        if(isKlaviyoAutoReply(h, m.snippet)){ await gapi(token,'messages/'+m.id+'/trash',{ method:'POST' }); trashed++; if(m.threadId) trashThreads.add(m.threadId); }
      }
    }
    after=list.nextPageToken; pages++;
  } while(after && pages<3);
  if(trashThreads.size){ try{ const idList=[...trashThreads].map(t=>'"'+t+'"').join(','); await rest('tickets?gmail_thread_id=in.('+idList+')',{ method:'DELETE', headers:{ Prefer:'return=minimal' } }); }catch(e){} }
  return { scanned, trashed };
}
module.exports = { runAutoReplyPurge, isKlaviyoAutoReply };
