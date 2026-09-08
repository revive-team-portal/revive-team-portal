// Lists all active products (grouped by product type) with per-variant stock at the primary
// location: available + committed, plus whether tracking is on. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { gql } = require('./_shopify');

async function primaryLocation() {
  const d = await gql('query{ locations(first:1, includeInactive:false){ edges { node { id name } } } }', {});
  const n = d.locations && d.locations.edges && d.locations.edges[0] && d.locations.edges[0].node;
  return n || null;
}

exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  try {
    const loc = await primaryLocation();
    if (!loc) return json(502, { error: 'No Shopify location found.' });
    const Q = `query($after:String,$loc:ID!){ products(first:25, query:"status:active", after:$after){ pageInfo{ hasNextPage endCursor } edges { node { id title productType variants(first:20){ edges { node { id title sku inventoryItem { id tracked inventoryLevel(locationId:$loc){ quantities(names:["available","committed"]){ name quantity } } } } } } } } } }`;
    const byType = {};
    let after = null, pages = 0;
    while (pages < 12) {
      const d = await gql(Q, { after, loc: loc.id });
      const conn = d.products; const edges = (conn && conn.edges) || [];
      for (const e of edges) {
        const p = e.node; const type = (p.productType || '').trim() || 'Other';
        for (const ve of (p.variants.edges || [])) {
          const v = ve.node; const inv = v.inventoryItem || {};
          const lvl = inv.inventoryLevel; const q = {};
          ((lvl && lvl.quantities) || []).forEach(x => { q[x.name] = x.quantity; });
          const vt = (v.title && v.title !== 'Default Title') ? (' — ' + v.title) : '';
          (byType[type] = byType[type] || []).push({
            name: p.title + vt, sku: v.sku || '',
            inventoryItemId: inv.id || null,
            tracked: !!inv.tracked,
            available: inv.tracked && lvl ? (q.available != null ? q.available : null) : null,
            committed: lvl ? (q.committed != null ? q.committed : 0) : 0,
          });
        }
      }
      pages++;
      if (!conn || !conn.pageInfo || !conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    const groups = Object.keys(byType).sort().map(type => ({
      type, items: byType[type].sort((x, y) => x.name.localeCompare(y.name)),
    }));
    const count = groups.reduce((n, g) => n + g.items.length, 0);
    return json(200, { location: { id: loc.id, name: loc.name }, count, groups });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
