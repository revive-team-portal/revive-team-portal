// Creates a $0 replacement order in Shopify from an existing order (100% discount).
// Copies line items + shipping address, tags 'replacement', notes the original. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { gql } = require('./_shopify');
const { rest, hasKey } = require('./_appsdb');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  const orderId = (body.orderId||'').trim();   // Shopify GID, e.g. gid://shopify/Order/123
  if (!orderId) return json(400, { error: 'No order id.' });

  try {
    const d = await gql(`query($id:ID!){ order(id:$id){ name email
      totalPriceSet{ shopMoney{ amount } } shippingAddress{ firstName lastName address1 address2 city province provinceCode zip country countryCodeV2 phone company }
      lineItems(first:60){ edges { node { quantity title variant{ id } } } } } }`, { id: orderId });
    const o = d.order;
    if (!o) return json(404, { error: 'Original order not found.' });

    const lineItems = (o.lineItems.edges||[]).map(e=>e.node).filter(n=>n.variant && n.variant.id).map(n=>({ variantId:n.variant.id, quantity:n.quantity }));
    if (!lineItems.length) return json(400, { error: 'No stockable items on the original order to replace.' });

    const sa = o.shippingAddress || {};
    const shippingAddress = sa.address1 ? {
      firstName:sa.firstName, lastName:sa.lastName, address1:sa.address1, address2:sa.address2,
      city:sa.city, province:sa.province, zip:sa.zip, country:sa.country, phone:sa.phone, company:sa.company,
    } : undefined;

    const input = {
      email: o.email || undefined,
      lineItems,
      appliedDiscount: { valueType:'PERCENTAGE', value:100.0, title:'Free replacement', description:'Replacement for '+o.name },
      tags:['replacement'],
      note:'Free replacement for order '+o.name,
      ...(shippingAddress ? { shippingAddress } : {}),
    };

    const cr = await gql(`mutation($input:DraftOrderInput!){ draftOrderCreate(input:$input){ draftOrder{ id } userErrors{ field message } } }`, { input });
    const dErr = cr.draftOrderCreate.userErrors;
    if (dErr && dErr.length) return json(502, { error: 'Draft error: '+dErr.map(e=>e.message).join('; ') });
    const draftId = cr.draftOrderCreate.draftOrder.id;

    const comp = await gql(`mutation($id:ID!){ draftOrderComplete(id:$id, paymentPending:false){ draftOrder{ order{ id name } } userErrors{ field message } } }`, { id: draftId });
    const cErr = comp.draftOrderComplete.userErrors;
    if (cErr && cErr.length) return json(502, { error: 'Complete error: '+cErr.map(e=>e.message).join('; ') });
    const order = comp.draftOrderComplete.draftOrder.order;
    // auto-log this replacement into the Resends register
    if (hasKey()) { try {
      const val = o.totalPriceSet && o.totalPriceSet.shopMoney ? Number(o.totalPriceSet.shopMoney.amount) : null;
      await rest('claims', { method:'POST', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({
        ticket_id: body.ticketId || null, order_name: o.name, resend_order: order.name,
        customer_name: body.customerName || '', customer_email: body.customerEmail || o.email || '',
        value: val, cause: null, status: 'Open', reason: 'Free replacement' }) });
    } catch(e){} }
    return json(200, { ok:true, orderName: order.name, orderId: order.id, from: o.name });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
