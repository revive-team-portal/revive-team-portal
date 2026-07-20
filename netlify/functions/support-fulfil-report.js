// "To be fulfilled" report: top SKUs (by outstanding qty) + SKU count by product type.
// Small page sizes to stay under Shopify's GraphQL cost limit; product type is optional
// (falls back gracefully if the app lacks read_products). Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { gql } = require('./_shopify');

const Q = 'fulfillment_status:unfulfilled status:open';

async function scan(withType){
  const skuMap = {}, typeMap = {};
  let after = null, pages = 0, orderCount = 0;
  const typeFrag = withType ? 'product{ productType }' : '';
  while (pages < 6) {
    const d = await gql(`query($q:String!,$after:String){ orders(first:25, query:$q, after:$after){ pageInfo{ hasNextPage endCursor } edges { node { lineItems(first:25){ edges { node { sku quantity title fulfillableQuantity ${typeFrag} } } } } } } }`, { q: Q, after });
    const conn = d.orders; const edges = (conn && conn.edges) || [];
    orderCount += edges.length;
    for (const e of edges) {
      for (const li of (e.node.lineItems.edges || [])) {
        const n = li.node;
        const qty = Number(n.fulfillableQuantity != null ? n.fulfillableQuantity : n.quantity) || 0;
        if (qty <= 0) continue;
        const sku = (n.sku && n.sku.trim()) || ('(no SKU) ' + (n.title || '').slice(0, 24));
        if (!skuMap[sku]) skuMap[sku] = { sku: (n.sku || '').trim(), title: n.title || '', qty: 0 };
        skuMap[sku].qty += qty;
        if (withType) { const type = (n.product && n.product.productType) || 'Other'; (typeMap[type] = typeMap[type] || new Set()).add(sku); }
      }
    }
    pages++;
    if (!conn || !conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return { orderCount, skuMap, typeMap };
}

exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  try {
    let res, productTypeUnavailable = false, typeError = null;
    try { res = await scan(true); }
    catch (e) { productTypeUnavailable = true; typeError = String(e && e.message || e).slice(0,240); res = await scan(false); }
    const topSkus = Object.values(res.skuMap).sort((x, y) => y.qty - x.qty).slice(0, 10);
    const byType = Object.keys(res.typeMap).map(t => ({ type: t, skuCount: res.typeMap[t].size })).sort((x, y) => y.skuCount - x.skuCount);
    return json(200, { orderCount: res.orderCount, topSkus, byType, productTypeUnavailable, typeError });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
