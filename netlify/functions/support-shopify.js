// Portal-gated Shopify lookup for the Customer Service module.
// POST { query }  -> resolves an email, name, or order number to customer(s) + recent orders.
const { json, validatePortalUser } = require('./_portal');
const { gql } = require('./_shopify');

const ORDER_FIELDS = `
  id name createdAt processedAt
  displayFinancialStatus displayFulfillmentStatus
  totalPriceSet { shopMoney { amount currencyCode } }
  customer { id firstName lastName email }
  shippingAddress { name address1 address2 city province zip country phone }
  lineItems(first: 30) { edges { node { title quantity sku
    originalUnitPriceSet { shopMoney { amount } } } } }
  fulfillments(first: 10) { status createdAt
    trackingInfo { number url company } }
  tags note`;

function mapOrder(n) {
  if (!n) return null;
  return {
    id: n.id, name: n.name, createdAt: n.processedAt || n.createdAt,
    financial: n.displayFinancialStatus, fulfillment: n.displayFulfillmentStatus,
    total: n.totalPriceSet?.shopMoney?.amount, currency: n.totalPriceSet?.shopMoney?.currencyCode,
    customer: n.customer ? { email: n.customer.email, name: [n.customer.firstName, n.customer.lastName].filter(Boolean).join(' ') } : null,
    shipTo: n.shippingAddress || null,
    lineItems: (n.lineItems?.edges || []).map(e => ({ title: e.node.title, qty: e.node.quantity, sku: e.node.sku, price: e.node.originalUnitPriceSet?.shopMoney?.amount })),
    tracking: (n.fulfillments || []).flatMap(f => (f.trackingInfo || []).map(t => ({ number: t.number, url: t.url, company: t.company, status: f.status }))),
    tags: n.tags || [], note: n.note || '',
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const auth = await validatePortalUser(event, 'support');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }
  const q = (body.query || '').trim();
  if (!q) return json(400, { error: 'Enter an email, name, or order number.' });

  try {
    const isOrder = /^#?\d{3,}$/.test(q);
    const isEmail = q.includes('@');

    if (isOrder) {
      const name = q.startsWith('#') ? q : '#' + q;
      const data = await gql(`query($q:String!){ orders(first:5, query:$q){ edges { node { ${ORDER_FIELDS} } } } }`, { q: 'name:' + name });
      const orders = (data.orders?.edges || []).map(e => mapOrder(e.node));
      return json(200, { customers: [], orders });
    }

    const custQ = isEmail ? 'email:' + q : q;
    const data = await gql(`query($cq:String!,$oq:String!){
      customers(first:5, query:$cq){ edges { node { id firstName lastName email phone numberOfOrders
        amountSpent { amount currencyCode } tags createdAt } } }
      orders(first:15, query:$oq, sortKey: CREATED_AT, reverse:true){ edges { node { ${ORDER_FIELDS} } } }
    }`, { cq: custQ, oq: (isEmail ? 'email:' + q : q) });

    const customers = (data.customers?.edges || []).map(e => ({
      id: e.node.id, name: [e.node.firstName, e.node.lastName].filter(Boolean).join(' '),
      email: e.node.email, phone: e.node.phone, orders: e.node.numberOfOrders,
      spent: e.node.amountSpent?.amount, currency: e.node.amountSpent?.currencyCode,
      tags: e.node.tags || [], since: e.node.createdAt,
    }));
    const orders = (data.orders?.edges || []).map(e => mapOrder(e.node));
    return json(200, { customers, orders });
  } catch (e) {
    return json(502, { error: String(e.message || e) });
  }
};
