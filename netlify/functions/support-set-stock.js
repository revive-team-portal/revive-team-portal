// Sets a variant's available stock at the primary location. quantity 0 = out of stock,
// any number = that stock level. Turns tracking on and activates the item at the location
// first (needed for setting quantities). Portal-gated (support). Needs write_inventory +
// read_locations. API 2026-07: inventorySetQuantities requires per-line changeFromQuantity
// (the current available) and a field-level @idempotent(key:) directive.
const { json, validatePortalUser } = require('./_portal');
const { gql } = require('./_shopify');
const crypto = require('crypto');

let _loc = null;
async function primaryLocation() {
  if (_loc) return _loc;
  const d = await gql('query{ locations(first:1, includeInactive:false){ edges { node { id } } } }', {});
  _loc = d.locations && d.locations.edges && d.locations.edges[0] && d.locations.edges[0].node && d.locations.edges[0].node.id;
  return _loc;
}

async function currentAvailable(id, loc) {
  try {
    const d = await gql('query($id:ID!,$loc:ID!){ inventoryItem(id:$id){ inventoryLevel(locationId:$loc){ quantities(names:["available"]){ quantity } } } }', { id, loc });
    const qs = d.inventoryItem && d.inventoryItem.inventoryLevel && d.inventoryItem.inventoryLevel.quantities;
    return (qs && qs.length) ? Number(qs[0].quantity) : 0;
  } catch (e) { return 0; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  const id = body.inventoryItemId;
  const qty = Math.round(Number(body.quantity));
  if (!id) return json(400, { error: 'Missing inventoryItemId.' });
  if (!Number.isFinite(qty) || qty < 0) return json(400, { error: 'Quantity must be 0 or a positive number.' });
  try {
    const loc = await primaryLocation();
    if (!loc) return json(502, { error: 'No Shopify location found.' });

    // 1) ensure tracked
    await gql('mutation($id:ID!){ inventoryItemUpdate(id:$id, input:{ tracked:true }){ userErrors{ message } } }', { id });
    // 2) ensure stocked at the location (ignore "already activated")
    try { await gql('mutation($id:ID!,$loc:ID!){ inventoryActivate(inventoryItemId:$id, locationId:$loc){ userErrors{ message } } }', { id, loc }); } catch (e) {}
    // 3) set available quantity (2026-07: needs changeFromQuantity + @idempotent)
    const cur = await currentAvailable(id, loc);
    const key = crypto.randomUUID();
    const d = await gql(
      'mutation($input:InventorySetQuantitiesInput!){ inventorySetQuantities(input:$input) @idempotent(key:"' + key + '"){ userErrors{ field message } } }',
      { input: { name: 'available', reason: 'correction', quantities: [{ inventoryItemId: id, locationId: loc, quantity: qty, changeFromQuantity: cur }] } }
    );
    const errs = (d.inventorySetQuantities && d.inventorySetQuantities.userErrors) || [];
    if (errs.length) return json(422, { error: errs.map(e => e.message).join('; ') });
    return json(200, { ok: true, available: qty });
  } catch (e) {
    const msg = String(e.message || e);
    if (/access denied|not approved|scope/i.test(msg)) return json(403, { error: 'Shopify write_inventory / read_locations permission is needed.' });
    return json(502, { error: msg });
  }
};
