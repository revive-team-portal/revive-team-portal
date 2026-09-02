const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  let body; try { body = JSON.parse(event.body||'{}'); } catch { return json(400,{error:'Bad request.'}); }
  const orderName=(body.orderName||'').trim(); const tracking=(body.trackingNumber||'').trim();
  const flag=body.flagReason||'Manually flagged';
  try {
    // dedupe: existing open row for same order+flag (or same tracking)
    let dq='naughty_orders?status=neq.resolved&select=id&limit=1';
    if(orderName) dq+='&order_name=eq.'+encodeURIComponent(orderName)+'&flag_reason=eq.'+encodeURIComponent(flag);
    else if(tracking) dq+='&tracking_number=eq.'+encodeURIComponent(tracking);
    else return json(400,{error:'Need an order or tracking number.'});
    const ex=await rest(dq);
    if(ex&&ex.length) return json(200,{ ok:true, duplicate:true });
    await rest('naughty_orders',{ method:'POST', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({
      order_name:orderName||null, tracking_number:tracking||null, customer_name:body.customerName||'', customer_email:body.customerEmail||'',
      value:body.value||null, flag_reason:flag, source:body.source||'manual', resend_order:body.resendOrder||'', ticket_id:body.ticketId||null, courier_status:body.courierStatus||null }) });
    return json(200,{ ok:true });
  } catch(e){ return json(502,{error:String(e.message||e)}); }
};
