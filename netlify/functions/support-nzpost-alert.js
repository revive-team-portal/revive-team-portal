const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
const { runNZPostAlertCheck } = require('./_nzpostalert');
exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(200, { active:false, message:'' });
  try {
    let body={}; try{ body=JSON.parse(event.body||'{}'); }catch{}
    if(body.check){ const r=await runNZPostAlertCheck(); return json(200, r); }
    const rows=await rest('settings?select=value&key=eq.nzpost_alert');
    let v={active:false,message:''}; try{ v=JSON.parse((rows&&rows[0]&&rows[0].value)||'{}'); }catch(e){}
    return json(200, v);
  } catch(e){ return json(200, { active:false, message:'' }); }
};
