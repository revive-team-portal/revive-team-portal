const { json, validatePortalUser } = require('./_portal');
const { runNZPostDelayScan } = require('./_nzpostdelay');
exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  let body={}; try{ body=JSON.parse(event.body||'{}'); }catch{}
  try { const r=await runNZPostDelayScan({ wide:true, diag: !!body.diag }); return json(200, r); }
  catch(e){ return json(502,{error:String(e.message||e)}); }
};
