const { gql } = require('./_shopify');
const { guard } = require('./_runkey');
const crypto = require('crypto');
exports.handler = async (event) => {
  if (!(await guard(event)).ok) return { statusCode: 403, body: 'nope' };
  try {
    const locD = await gql('query{ locations(first:1, includeInactive:false){ edges{ node{ id name } } } }');
    const loc = locD.locations.edges[0].node;
    const q = await gql('query($loc:ID!){ productVariants(first:30, query:"inventory_quantity:>0"){ nodes{ displayName inventoryItem{ id tracked inventoryLevel(locationId:$loc){ quantities(names:["available"]){ quantity } } } } } }', { loc: loc.id });
    const cand = (q.productVariants.nodes||[]).find(n => n.inventoryItem && n.inventoryItem.tracked && n.inventoryItem.inventoryLevel && n.inventoryItem.inventoryLevel.quantities.length);
    if (!cand) return { statusCode: 200, body: JSON.stringify({ note:'no tracked candidate' }) };
    const cur = cand.inventoryItem.inventoryLevel.quantities[0].quantity;
    const key = crypto.randomUUID();
    const d = await gql(
      'mutation($input:InventorySetQuantitiesInput!){ inventorySetQuantities(input:$input) @idempotent(key:"'+key+'"){ userErrors{ field message } inventoryAdjustmentGroup{ createdAt } } }',
      { input: { name:'available', reason:'correction', quantities:[{ inventoryItemId:cand.inventoryItem.id, locationId:loc.id, quantity:cur, changeFromQuantity:cur }] } }
    );
    return { statusCode: 200, headers:{'Content-Type':'application/json','Cache-Control':'no-store'}, body: JSON.stringify({ item:cand.displayName, current:cur, result:d.inventorySetQuantities }, null, 1) };
  } catch (e) { return { statusCode: 200, headers:{'Cache-Control':'no-store'}, body: JSON.stringify({ err:String(e.message||e) }) }; }
};
