const { json, validatePortalUser } = require('./_portal');
const { getAccessToken } = require('./_gmail');
function parseName(s){ const m=(s||'').match(/^\s*"?([^"<]+?)"?\s*</); return m?m[1].trim():(s||''); }
async function gapi(t,p){ const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/'+p,{headers:{Authorization:'Bearer '+t}}); return r.json().catch(()=>({})); }
exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  const at = await getAccessToken('cafe'); if(!at.ok) return json(400,{error:at.error});
  try {
    const list=await gapi(at.access_token,'messages?maxResults=50&q='+encodeURIComponent('in:spam'));
    const ids=(list.messages||[]).map(m=>m.id).slice(0,50); const items=[];
    for(let i=0;i<ids.length;i+=6){ const b=await Promise.all(ids.slice(i,i+6).map(id=>gapi(at.access_token,'messages/'+id+'?format=metadata&metadataHeaders=From&metadataHeaders=Subject')));
      for(const m of b){ const h={}; ((m.payload&&m.payload.headers)||[]).forEach(x=>h[x.name.toLowerCase()]=x.value); items.push({ id:m.id, from:parseName(h.from||''), subject:h.subject||'(no subject)', snippet:(m.snippet||'').slice(0,120) }); } }
    return json(200, { count: items.length, items });
  } catch(e){ return json(502,{error:String(e.message||e)}); }
};
