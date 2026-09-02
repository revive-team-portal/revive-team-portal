const { rest } = require('./_appsdb');
const { getAccessToken } = require('./_gmail');
const { track } = require('./_eship');
function b64(s){ return Buffer.from((s||'').replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'); }
function bodyText(payload){ let o=''; (function w(p){ if(!p) return; if(p.parts) p.parts.forEach(w); if((p.mimeType==='text/plain'||p.mimeType==='text/html')&&p.body&&p.body.data) o+=' '+b64(p.body.data); })(payload); return o.replace(/<[^>]+>/g,' '); }
async function gapi(t,p){ const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/'+p,{headers:{Authorization:'Bearer '+t}}); return r.json().catch(()=>({})); }
const TRK=/\b([A-Z]{2}\d{9}NZ|\d{16,24})\b/g;
async function runNZPostDelayScan(){
  const at=await getAccessToken('cafe'); if(!at.ok) return { ok:false };
  const token=at.access_token;
  const list=await gapi(token,'messages?maxResults=25&q='+encodeURIComponent('(from:nzpost.co.nz OR from:courierpost.co.nz OR from:nzpost) newer_than:3d (delay OR delayed OR exception OR unable OR "not delivered" OR update)'));
  const ids=(list.messages||[]).map(m=>m.id).slice(0,20);
  let added=0, scanned=0;
  for(const id of ids){ scanned++;
    const m=await gapi(token,'messages/'+id+'?format=full'); const txt=bodyText(m.payload||{});
    const nums=[...new Set((txt.match(TRK)||[]))].slice(0,5);
    for(const tn of nums){ const t=await track({ trackingNumber:tn }); if(!t.ok) continue;
      if(/deliver(ed)?$/i.test(t.status||'')) continue; // already delivered, skip
      const orderName=t.orderNumber||'';
      // dedupe
      const ex=await rest('naughty_orders?status=neq.resolved&tracking_number=eq.'+encodeURIComponent(tn)+'&select=id&limit=1');
      if(ex&&ex.length) continue;
      await rest('naughty_orders',{ method:'POST', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({ order_name:orderName||null, tracking_number:tn, flag_reason:'NZ Post delay', source:'nzpost_email', courier_status:t.status||null, status:'open' }) });
      added++;
    }
  }
  return { ok:true, scanned, added };
}
module.exports = { runNZPostDelayScan };
