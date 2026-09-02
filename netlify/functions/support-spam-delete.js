const { json, validatePortalUser } = require('./_portal');
const { getAccessToken } = require('./_gmail');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  const at = await getAccessToken('cafe'); if(!at.ok) return json(400,{error:at.error});
  let body; try { body = JSON.parse(event.body||'{}'); } catch { return json(400,{error:'Bad request.'}); }
  const ids = Array.isArray(body.ids)?body.ids.slice(0,50):[];
  const rescue = !!body.rescue;
  if(!ids.length) return json(400,{error:'No messages.'});
  try { let done=0;
    for(const id of ids){ if(rescue){ await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+id+'/modify',{method:'POST',headers:{Authorization:'Bearer '+at.access_token,'Content-Type':'application/json'},body:JSON.stringify({removeLabelIds:['SPAM'],addLabelIds:['INBOX']})}); }
      else { await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+id+'/trash',{method:'POST',headers:{Authorization:'Bearer '+at.access_token}}); } done++; }
    return json(200,{ok:true, done, rescued:rescue}); }
  catch(e){ return json(502,{error:String(e.message||e)}); }
};
