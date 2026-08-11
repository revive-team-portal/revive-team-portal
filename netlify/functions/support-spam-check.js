const { json, validatePortalUser } = require('./_portal');
const { runSpamCheck } = require('./_spamcheck');
exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  try { const r=await runSpamCheck(); return json(r.ok?200:400, r); } catch(e){ return json(502,{ error:String(e.message||e) }); }
};
