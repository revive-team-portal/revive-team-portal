// Purge Klaviyo auto-replies. SAFE: only trashes a message that is BOTH an auto-reply AND
// references / quotes a Klaviyo-sent email (Klaviyo's link domains appear in the quoted body).
const { rest } = require('./_appsdb');
async function gapi(token,path,opts){ const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{ ...(opts||{}), headers:{ Authorization:'Bearer '+token } }); return r.json().catch(()=>({})); }
function b64(s){ return Buffer.from((s||'').replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'); }
function fullText(payload){ let out=''; (function w(p){ if(!p) return; if(p.parts) p.parts.forEach(w); if((p.mimeType==='text/plain'||p.mimeType==='text/html')&&p.body&&p.body.data) out+=' '+b64(p.body.data); })(payload); return out; }
const AUTO_SUBJ=/^(re:\s*)?(automatic reply|auto[- ]?reply|out of office|out-of-office|away from|on leave|annual leave|on vacation|vacation|currently out|maternity leave|i am (currently )?(out|away|on)|thank you for (your email|contacting|getting))/i;
function isAutoReply(h){ return /auto-?replied|auto-?generated/i.test(h['auto-submitted']||'') || h['x-autoreply']!=null || h['x-autorespond']!=null || h['x-auto-response-suppress']!=null || /(auto_reply|auto-reply)/i.test(h['precedence']||'') || AUTO_SUBJ.test(h.subject||''); }
const KLAVIYO=/klaviyo|klaviyomail|klclick\.com|kmail-lists\.com|manage\.kmail|a\.klaviyo/i;
const HDRS=['Subject','From','Auto-Submitted','X-Autoreply','X-Autorespond','X-Auto-Response-Suppress','Precedence','References','In-Reply-To'].map(x=>'metadataHeaders='+x).join('&');
async function runAutoReplyPurge(token){
  let after=null,pages=0,scanned=0,candidates=0,trashed=0; const trashThreads=new Set();
  do {
    const list=await gapi(token,'messages?maxResults=100&q='+encodeURIComponent('in:inbox newer_than:60d')+(after?('&pageToken='+after):''));
    const ids=(list.messages||[]).map(m=>m.id);
    for(let i=0;i<ids.length;i+=5){
      const b=await Promise.all(ids.slice(i,i+5).map(id=>gapi(token,'messages/'+id+'?format=metadata&'+HDRS)));
      for(const m of b){ scanned++; const h={}; ((m.payload&&m.payload.headers)||[]).forEach(x=>h[x.name.toLowerCase()]=x.value);
        if(!isAutoReply(h)) continue; candidates++;
        let klav = KLAVIYO.test((h['references']||'')+' '+(h['in-reply-to']||'')+' '+(m.snippet||''));
        if(!klav){ try{ const full=await gapi(token,'messages/'+m.id+'?format=full'); klav=KLAVIYO.test(fullText(full.payload||{})); }catch(e){} }
        if(klav){ await gapi(token,'messages/'+m.id+'/trash',{ method:'POST' }); trashed++; if(m.threadId) trashThreads.add(m.threadId); }
      }
    }
    after=list.nextPageToken; pages++;
  } while(after && pages<3);
  if(trashThreads.size){ try{ const idList=[...trashThreads].map(t=>'"'+t+'"').join(','); await rest('tickets?gmail_thread_id=in.('+idList+')',{ method:'DELETE', headers:{ Prefer:'return=minimal' } }); }catch(e){} }
  return { scanned, candidates, trashed };
}
module.exports = { runAutoReplyPurge, isAutoReply };
