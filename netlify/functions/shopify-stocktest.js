// TEMPORARY. ?k=<runkey> — validates corrected inventorySetQuantities by setting a
// tracked item to its CURRENT available qty (net-zero). Returns userErrors.
const { gql } = require('./_shopify');
const { guard } = require('./_runkey');
exports.handler = async (event) => {
  if (!(await guard(event)).ok) return { statusCode: 403, body: 'nope' };
  try {
    const locD = await gql('query{ locations(first:1, includeInactive:false){ edges{ node{ id name } } } }');
    const loc = locD.locations.edges[0].node;
    // find a tracked variant with inventory at this location
    const q = await gql('query($loc:ID!){ productVariants(first:20, query:"inventory_quantity:>0"){ nodes{ displayName inventoryItem{ id tracked inventoryLevel(locationId:$loc){ quantities(names:["available"]){ name quantity } } } } } }', { loc: loc.id });
    const cand = (q.productVariants.nodes || []).find(n => n.inventoryItem && n.inventoryItem.tracked && n.inventoryItem.inventoryLevel && n.inventoryItem.inventoryLevel.quantities.length);
    if (!cand) return { statusCode: 200, body: JSON.stringify({ note: 'no tracked candidate found', loc }) };
    const cur = cand.inventoryItem.inventoryLevel.quantities[0].quantity;
    const d = await gql(
      'mutation($input:InventorySetQuantitiesInput!){ inventorySetQuantities(input:$input){ userErrors{ field message } inventoryAdjustmentGroup{ createdAt } } }',
      { input: { name: 'available', reason: 'correction', quantities: [{ inventoryItemId: cand.inventoryItem.id, locationId: loc.id, quantity: cur }] } }
    );
    return { statusCode: 200, headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ item: cand.displayName, current: cur, result: d.inventorySetQuantities }, null, 1) };
  } catch (e) { return { statusCode: 200, body: JSON.stringify({ err: String(e.message || e) }) }; }
};
