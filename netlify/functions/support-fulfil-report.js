// "To be fulfilled" report: top SKUs (by qty) + SKU count by product type, from unfulfilled orders.
// Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { gql } = require('./_shopify');

exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  try {
    const q = 'fulfillment_status:unfulfilled status:open';
    const skuMap = {};          // sku -> { sku, title, qty }
    const typeMap = {};         // type -> Set(sku)
    let after = null, pages = 0, orderCount = 0;
    while (pages < 3) {
      const d = await gql(`query($q:String!,$after:String){ orders(first:100, query:$q, after:$after){ pageInfo{ hasNextPage endCursor } edges { node { lineItems(first:100){ edges { node { sku quantity title product{ productType } fulfillableQuantity } } } } } } }`, { q, after });
      const conn = d.orders; const edges = (conn && conn.edges) || [];
      orderCount += edges.length;
      for (const e of edges) {
        for (const li of (e.node.lineItems.edges||[])) {
          const n = li.node;
          const qty = Number(n.fulfillableQuantity != null ? n.fulfillableQuantity : n.quantity) || 0;
          if (qty <= 0) continue;
          const sku = (n.sku && n.sku.trim()) || ('(no SKU) '+(n.title||'').slice(0,24));
          if (!skuMap[sku]) skuMap[sku] = { sku: (n.sku||'').trim(), title: n.title||'', qty: 0 };
          skuMap[sku].qty += qty;
          const type = (n.product && n.product.productType) || 'Other';
          (typeMap[type] = typeMap[type] || new Set()).add(sku);
        }
      }
      pages++;
      if (!conn || !conn.pageInfo || !conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    const topSkus = Object.values(skuMap).sort((x,y)=>y.qty-x.qty).slice(0,10);
    const byType = Object.keys(typeMap).map(t=>({ type:t, skuCount: typeMap[t].size })).sort((x,y)=>y.skuCount-x.skuCount);
    return json(200, { orderCount, topSkus, byType });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
