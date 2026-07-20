// Out-of-stock items on the website (active products, variants not available for sale).
// Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { gql } = require('./_shopify');
const Q = 'status:active';
exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  try {
    const items = []; let after = null, pages = 0;
    while (pages < 6 && items.length < 300) {
      const d = await gql(`query($q:String!,$after:String){ products(first:40, query:$q, after:$after){ pageInfo{ hasNextPage endCursor } edges { node { title variants(first:8){ edges { node { title sku availableForSale inventoryQuantity } } } } } } }`, { q: Q, after });
      const conn = d.products; const edges = (conn && conn.edges) || [];
      for (const e of edges) {
        const pt = e.node.title;
        for (const v of (e.node.variants.edges || [])) {
          const vn = v.node;
          if (vn.availableForSale === false) {
            const vt = (vn.title && vn.title !== 'Default Title') ? (' — ' + vn.title) : '';
            items.push({ name: pt + vt, sku: vn.sku || '', qty: vn.inventoryQuantity });
          }
        }
      }
      pages++;
      if (!conn || !conn.pageInfo || !conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    items.sort((x, y) => x.name.localeCompare(y.name));
    return json(200, { count: items.length, items });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
