const { rest } = require('./_appsdb');
const { getAccessToken } = require('./_gmail');
const { track } = require('./_eship');
function b64(s){ return Buffer.from((s||'').replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'); }
function bodyText(payload){ let o=''; (function w(p){ if(!p) return; if(p.parts) p.parts.forEach(w); if((p.mimeType==='text/plain'||p.mimeType==='text/html')&&p.body&&p.body.data) o+=' '+b64(p.body.data); })(payload); return o.replace(/<[^>]+>/g,' ').replace(/\s+/g,' '); }
async function gapi(t,p){ const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/'+p,{headers:{Authorization:'Bearer '+t}}); return r.json().catch(()=>({})); }
const TRK=/\b([A-Z]{2}\d{9}NZ|[A-Z]{2}\d{9}\b|\d{16,24}|[A-Z0-9]{10,14})\b/g;
async function runNZPostDelayScan(opts){
  opts=opts||{};
  const at=await getAccessToken('cafe'); if(!at.ok) return { ok:false, error:at.error };
  const token=at.access_token;
  const scope = opts.wide ? 'in:anywhere newer_than:45d' : 'in:inbox newer_than:4d';
  const q='('+scope+') (from:nzpost.co.nz OR from:courierpost.co.nz OR from:nzpost OR "New Zealand Post" OR "nzpost")';
  const list=await gapi(token,'messages?maxResults=25&q='+encodeURIComponent(q));
  const ids=(list.messages||[]).map(m=>m.id).slice(0,20);
  let added=0, scanned=0; const found=[];
  for(const id of ids){ scanned++;
    const m=await gapi(token,'messages/'+id+'?format=full');
    const h={}; ((m.payload&&m.payload.headers)||[]).forEach(x=>h[x.name.toLowerCase()]=x.value);
    const txt=bodyText(m.payload||{});
    const nums=[...new Set((txt.match(TRK)||[]).filter(x=>/\d/.test(x)))].slice(0,6);
    const matched=[];
    for(const tn of nums){ const t=await track({ trackingNumber:tn }); if(!t.ok) continue;
      matched.push({ tn, order:t.orderNumber||'', status:t.status||'' });
      if(/deliver(ed)?/i.test(t.status||'')) continue;
      const ex=await rest('naughty_orders?status=neq.resolved&tracking_number=eq.'+encodeURIComponent(tn)+'&select=id&limit=1');
      if(ex&&ex.length) continue;
      await rest('naughty_orders',{ method:'POST', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({ order_name:t.orderNumber||null, tracking_number:tn, flag_reason:'NZ Post delay', source:'nzpost_email', courier_status:t.status||null, status:'open' }) });
      added++;
    }
    if(found.length<6) found.push({ from:h.from||'', subject:h.subject||'', trackingFound:nums, matched, bodySample: opts.diag? txt.slice(0,400):undefined });
  }
  return { ok:true, scanned, added, found };
}
module.exports = { runNZPostDelayScan };
