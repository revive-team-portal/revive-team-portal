// One-off / occasional backfill: enrich support.customers with lifetime spend, city and
// order count from Shopify, so the ticket list can show a customer profile box.
// Background function (up to 15 min). No auth: server-side only.
const { rest } = require('./_appsdb');
const { gql } = require('./_shopify');

const Q = 'query($q:String!){ customers(first:1, query:$q){ edges { node { numberOfOrders amountSpent { amount } defaultAddress { city province } } } } }';

exports.handler = async () => {
  let updated = 0, scanned = 0;
  try {
    const rows = await rest('customers?select=id,email,orders_count,lifetime_value,city&order=updated_at.desc&limit=1000');
    for (const c of (rows || [])) {
      const email = (c.email || '').trim();
      if (!email || /@no-email\.local$/i.test(email)) continue;
      scanned++;
      try {
        const d = await gql(Q, { q: 'email:' + email });
        const n = (d.customers && d.customers.edges && d.customers.edges[0] && d.customers.edges[0].node) || null;
        if (!n) continue;
        const addr = n.defaultAddress || null;
        const patch = {
          orders_count: Number(n.numberOfOrders || 0),
          lifetime_value: n.amountSpent ? Number(n.amountSpent.amount || 0) : (c.lifetime_value || 0),
          city: addr ? (addr.city || addr.province || null) : (c.city || null),
        };
        await rest('customers?id=eq.' + c.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
        updated++;
      } catch (e) { /* skip this one */ }
      await new Promise(r => setTimeout(r, 120)); // gentle on Shopify rate limits
    }
    console.log('support-customer-enrich', JSON.stringify({ scanned, updated }));
    return { statusCode: 200, body: JSON.stringify({ scanned, updated }) };
  } catch (e) {
    console.log('support-customer-enrich error', String((e && e.message) || e));
    return { statusCode: 500, body: String((e && e.message) || e) };
  }
};
