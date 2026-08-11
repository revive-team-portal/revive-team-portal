// Scans the SPAM folder for legitimate customer emails and rescues them to the inbox.
const { getAccessToken } = require('./_gmail');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
async function gapi(token, path, opts){ const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{ ...(opts||{}), headers:{ Authorization:'Bearer '+token, ...(opts&&opts.headers||{}) } }); return r.json().catch(()=>({})); }
let CHECKED_LABEL=null;
async function ensureLabel(token){
  if(CHECKED_LABEL) return CHECKED_LABEL;
  const d=await gapi(token,'labels');
  const f=(d.labels||[]).find(l=>l.name==='Revive/SpamChecked');
  if(f){ CHECKED_LABEL=f.id; return f.id; }
  const c=await gapi(token,'labels',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ name:'Revive/SpamChecked', labelListVisibility:'labelHide', messageListVisibility:'hide' }) });
  CHECKED_LABEL=c.id||null; return CHECKED_LABEL;
}
async function runSpamCheck(){
  const at=await getAccessToken('cafe');
  if(!at.ok) return { ok:false, error:at.error };
  const token=at.access_token;
  const list=await gapi(token,'messages?maxResults=25&q='+encodeURIComponent('in:spam newer_than:4d -label:Revive/SpamChecked'));
  const ids=(list.messages||[]).map(m=>m.id).slice(0,20);
  if(!ids.length) return { ok:true, checked:0, rescued:0 };
  const items=[];
  for(let i=0;i<ids.length;i+=6){ const b=await Promise.all(ids.slice(i,i+6).map(id=>gapi(token,'messages/'+id+'?format=metadata&metadataHeaders=From&metadataHeaders=Subject'))); for(const m of b){ const h={}; ((m.payload&&m.payload.headers)||[]).forEach(x=>h[x.name.toLowerCase()]=x.value); items.push({ id:m.id, from:h.from||'', subject:h.subject||'', snippet:(m.snippet||'').replace(/\s+/g,' ').slice(0,160) }); } }
  let legit=new Set();
  if(ANTHROPIC_KEY){
    try{
      const prompt=`The SPAM folder of a NZ gluten-free food company's customer-service inbox (cafe@revive.co.nz) sometimes catches LEGITIMATE customer emails (order questions, delivery/refund issues, enquiries, replies, suppliers). For each email below decide: legitimate customer/business email to rescue, or genuine spam/marketing/phishing. Return ONLY a JSON array of the 1-based indexes that are legitimate.\n\n`+items.map((x,i)=>(i+1)+'. From: '+x.from+' | '+x.subject+' | '+x.snippet).join('\n');
      const res=await fetch('https://api.anthropic.com/v1/messages',{ method:'POST', headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'}, body:JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:300, messages:[{role:'user',content:prompt}] }) });
      const d=await res.json().catch(()=>({})); let t=((d.content&&d.content[0]&&d.content[0].text)||'').replace(/```json/gi,'').replace(/```/g,'').trim();
      const arr=JSON.parse(t); if(Array.isArray(arr)) arr.forEach(n=>legit.add(Number(n)-1));
    }catch(e){}
  }
  const labelId=await ensureLabel(token);
  let rescued=0;
  for(let i=0;i<items.length;i++){
    const it=items[i];
    if(legit.has(i)){ await gapi(token,'messages/'+it.id+'/modify',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ removeLabelIds:['SPAM'], addLabelIds:['INBOX'] }) }); rescued++; }
    else { await gapi(token,'messages/'+it.id+'/modify',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ addLabelIds: labelId?[labelId]:[] }) }); }
  }
  return { ok:true, checked:items.length, rescued };
}
module.exports = { runSpamCheck };
