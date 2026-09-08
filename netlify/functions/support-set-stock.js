// Sets a variant's available stock at the primary location. quantity 0 = out of stock,
// any number = that stock level. Turns tracking on and activates the item at the location
// first (needed for setting quantities). Portal-gated (support). Needs write_inventory.
const { json, validatePortalUser } = require('./_portal');
const { gql } = require('./_shopify');

let _loc = null;
async function primaryLocation() {
  if (_loc) return _loc;
  const d = await gql('query{ locations(first:1, includeInactive:false){ edges { node { id } } } }', {});
  _loc = d.locations && d.locations.edges && d.locations.edges[0] && d.locations.edges[0].node && d.locations.edges[0].node.id;
  return _loc;
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
    // 3) set available quantity
    const d = await gql(
      'mutation($input:InventorySetQuantitiesInput!){ inventorySetQuantities(input:$input){ userErrors{ field message } } }',
      { input: { name: 'available', reason: 'correction', ignoreCompareQuantity: true, quantities: [{ inventoryItemId: id, locationId: loc, quantity: qty }] } }
    );
    const errs = (d.inventorySetQuantities && d.inventorySetQuantities.userErrors) || [];
    if (errs.length) return json(422, { error: errs.map(e => e.message).join('; ') });
    return json(200, { ok: true, available: qty });
  } catch (e) {
    const msg = String(e.message || e);
    if (/access denied|not approved|scope/i.test(msg)) return json(403, { error: 'Shopify write_inventory permission is needed.' });
    return json(502, { error: msg });
  }
};
