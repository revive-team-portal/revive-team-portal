// Stores/refreshes a ticket's courier (NZ Post) status. Portal-gated (support).
// { id, status, trackingNumber } stores directly; { id, refresh:true } resolves server-side.
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
const { gql } = require('./_shopify');
const { track } = require('./_eship');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  if (!body.id) return json(400, { error: 'No ticket id.' });

  try {
    if (!body.refresh) {
      await rest('tickets?id=eq.'+encodeURIComponent(body.id), { method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({
        courier_status: body.status||null, tracking_number: body.trackingNumber||null, courier_checked_at: new Date().toISOString() }) });
      return json(200, { ok:true, status: body.status||null });
    }
    // refresh: resolve tracking number then courier status
    const t = await rest('tickets?id=eq.'+encodeURIComponent(body.id)+'&select=matched_order,tracking_number,customer:customers(email)&limit=1');
    if (!t || !t.length) return json(404, { error: 'Ticket not found.' });
    const row = t[0]; let tn = row.tracking_number;
    if (!tn) {
      const q = row.matched_order ? ('name:'+row.matched_order) : (row.customer && row.customer.email ? ('email:'+row.customer.email) : '');
      if (q) {
        const d = await gql('query($q:String!){ orders(first:1, query:$q, sortKey:CREATED_AT, reverse:true){ edges { node { fulfillments(first:3){ trackingInfo{ number } } } } } }', { q });
        const node = d.orders && d.orders.edges && d.orders.edges[0] && d.orders.edges[0].node;
        tn = node ? (node.fulfillments||[]).flatMap(f=>(f.trackingInfo||[]).map(x=>x.number)).filter(Boolean)[0] : null;
      }
    }
    if (!tn) { await rest('tickets?id=eq.'+encodeURIComponent(body.id), { method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({ courier_checked_at:new Date().toISOString() }) }); return json(200, { ok:true, status:null }); }
    const tr = await track({ trackingNumber: tn });
    const status = tr.ok ? tr.status : null;
    await rest('tickets?id=eq.'+encodeURIComponent(body.id), { method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({ courier_status: status, tracking_number: tn, courier_checked_at: new Date().toISOString() }) });
    return json(200, { ok:true, status });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
