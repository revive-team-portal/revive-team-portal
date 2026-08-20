const { json, validatePortalUser } = require('./_portal');
const { getAccessToken } = require('./_gmail');
const { rest, hasKey } = require('./_appsdb');
let LBL=null;
async function ensureLabel(token){ if(LBL) return LBL; const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels',{headers:{Authorization:'Bearer '+token}}); const d=await r.json().catch(()=>({})); const f=(d.labels||[]).find(l=>l.name==='Revive/Resolved'); if(f){LBL=f.id;return f.id;} const c=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({name:'Revive/Resolved',labelListVisibility:'labelShow',messageListVisibility:'show'})}); const cd=await c.json().catch(()=>({})); LBL=cd.id||null; return LBL; }
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  let body; try { body = JSON.parse(event.body||'{}'); } catch { return json(400,{error:'Bad request.'}); }
  const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean).slice(0,200) : [];
  if (!ids.length) return json(400, { error: 'No tickets selected.' });
  const excluded = body.excluded !== false; // filed items don't count by default
  try {
    const idList = ids.map(i=>'"'+i+'"').join(',');
    const rows = await rest('tickets?id=in.('+idList+')&select=id,gmail_thread_id');
    const at = await getAccessToken('cafe');
    if (at.ok) { const lbl=await ensureLabel(at.access_token);
      for (const t of (rows||[])) { if(t.gmail_thread_id){ try{ await fetch('https://gmail.googleapis.com/gmail/v1/users/me/threads/'+encodeURIComponent(t.gmail_thread_id)+'/modify',{ method:'POST', headers:{Authorization:'Bearer '+at.access_token,'Content-Type':'application/json'}, body:JSON.stringify({ removeLabelIds:['INBOX'], addLabelIds: lbl?[lbl]:[] }) }); }catch(e){} } }
    }
    await rest('tickets?id=in.('+idList+')', { method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({ status:'Resolved', excluded, resolved_at:new Date().toISOString(), updated_at:new Date().toISOString() }) });
    return json(200, { ok:true, count: ids.length });
  } catch (e) { return json(502, { error: String(e.message||e) }); }
};
