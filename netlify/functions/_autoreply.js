// Purge auto-replies to messages we did NOT send from cafe@'s Gmail (i.e. Klaviyo/bulk sends).
// SAFE: a real out-of-office reply to one of OUR cafe@ emails has our sent message in the
// thread, so it is kept. Only auto-replies with no cafe@ outbound in the thread are trashed.
const { rest } = require('./_appsdb');
async function gapi(token,path,opts){ const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{ ...(opts||{}), headers:{ Authorization:'Bearer '+token } }); return r.json().catch(()=>({})); }
const AUTO_SUBJ=/^(re:\s*)?(automatic reply|auto[- ]?reply|out of office|out-of-office|away from|on leave|annual leave|on vacation|vacation|currently out|maternity leave|i am (currently )?(out|away|on)|thank you for (your email|contacting|getting))/i;
function isAutoReply(h){ return /auto-?replied|auto-?generated/i.test(h['auto-submitted']||'') || h['x-autoreply']!=null || h['x-autorespond']!=null || h['x-auto-response-suppress']!=null || /(auto_reply|auto-reply)/i.test(h['precedence']||'') || AUTO_SUBJ.test(h.subject||''); }
const HDRS=['Subject','From','Auto-Submitted','X-Autoreply','X-Autorespond','X-Auto-Response-Suppress','Precedence'].map(x=>'metadataHeaders='+x).join('&');
async function threadHasOurSend(token, threadId){
  try{ const th=await gapi(token,'threads/'+threadId+'?format=metadata&metadataHeaders=From');
    for(const tm of (th.messages||[])){ const fh=((tm.payload&&tm.payload.headers)||[]).find(x=>x.name.toLowerCase()==='from'); if(fh && /cafe@revive\.co\.nz/i.test(fh.value||'')) return true; }
    return false;
  }catch(e){ return true; } // fail safe: keep
}
async function runAutoReplyPurge(token){
  let after=null,pages=0,scanned=0,candidates=0,trashed=0; const trashThreads=new Set();
  do {
    const list=await gapi(token,'messages?maxResults=100&q='+encodeURIComponent('in:inbox newer_than:60d')+(after?('&pageToken='+after):''));
    const ids=(list.messages||[]).map(m=>m.id);
    for(let i=0;i<ids.length;i+=5){
      const b=await Promise.all(ids.slice(i,i+5).map(id=>gapi(token,'messages/'+id+'?format=metadata&'+HDRS)));
      for(const m of b){ scanned++; const h={}; ((m.payload&&m.payload.headers)||[]).forEach(x=>h[x.name.toLowerCase()]=x.value);
        if(!isAutoReply(h)) continue; candidates++;
        const ours=await threadHasOurSend(token, m.threadId);
        if(!ours){ await gapi(token,'messages/'+m.id+'/trash',{ method:'POST' }); trashed++; if(m.threadId) trashThreads.add(m.threadId); }
      }
    }
    after=list.nextPageToken; pages++;
  } while(after && pages<3);
  if(trashThreads.size){ try{ const idList=[...trashThreads].map(t=>'"'+t+'"').join(','); await rest('tickets?gmail_thread_id=in.('+idList+')',{ method:'DELETE', headers:{ Prefer:'return=minimal' } }); }catch(e){} }
  return { scanned, candidates, trashed };
}
module.exports = { runAutoReplyPurge, isAutoReply };
