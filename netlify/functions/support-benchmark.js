// Benchmarks the friendliness of the last N sent emails from cafe@. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { getAccessToken } = require('./_gmail');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
function b64(s){ return Buffer.from((s||'').replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'); }
function extractText(payload){ let plain='',html=''; (function w(p){ if(!p) return; if(p.parts) p.parts.forEach(w); if(p.mimeType==='text/plain'&&p.body&&p.body.data) plain+=b64(p.body.data); else if(p.mimeType==='text/html'&&p.body&&p.body.data) html+=b64(p.body.data); })(payload); const t=plain.trim()?plain:html.replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' '); return t.replace(/\s+/g,' ').trim(); }
async function gapi(token,path){ const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{headers:{Authorization:'Bearer '+token}}); return r.json().catch(()=>({})); }
exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!ANTHROPIC_KEY) return json(500, { error: 'AI not configured.' });
  const at = await getAccessToken('cafe');
  if (!at.ok) return json(400, { error: at.error });
  try {
    const n = Math.min(Number((JSON.parse(event.body||'{}')).n)||20, 30);
    const list = await gapi(at.access_token, 'messages?maxResults='+n+'&q='+encodeURIComponent('from:cafe@revive.co.nz'));
    const ids = (list.messages||[]).map(m=>m.id).slice(0,n);
    if (!ids.length) return json(200, { count:0, average:null, scores:[] });
    const emails=[];
    for (let i=0;i<ids.length;i+=6){ const b=await Promise.all(ids.slice(i,i+6).map(id=>gapi(at.access_token,'messages/'+id+'?format=full'))); for(const m of b){ const h={}; ((m.payload&&m.payload.headers)||[]).forEach(x=>h[x.name.toLowerCase()]=x.value); emails.push({ subject:h.subject||'', to:h.to||'', text: extractText(m.payload).slice(0,700) }); } }
    const prompt = `Rate each sent Revive Café customer-service reply for LAVISH, warm friendliness out of 10 (10 = effusively warm greeting + genuinely caring body + warm closing; low = curt, flat, transactional). Return ONLY a JSON array of integers, one per email in the same order.\n\n`+emails.map((e,i)=>(i+1)+'. '+e.text).join('\n\n');
    const res = await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{ 'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01' }, body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:400, messages:[{ role:'user', content:prompt }] }) });
    const d = await res.json().catch(()=>({}));
    let t = ((d.content&&d.content[0]&&d.content[0].text)||'').replace(/```json/gi,'').replace(/```/g,'').trim();
    let arr=[]; try{ arr=JSON.parse(t); }catch(e){}
    const scores = emails.map((e,i)=>({ subject:e.subject||'(no subject)', to:e.to, score: (arr[i]!=null?Number(arr[i]):null) }));
    const valid = scores.map(x=>x.score).filter(x=>x!=null&&!isNaN(x));
    const average = valid.length ? Math.round((valid.reduce((s,x)=>s+x,0)/valid.length)*10)/10 : null;
    const below8 = valid.filter(x=>x<8).length;
    return json(200, { count: emails.length, average, below8, scores });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
