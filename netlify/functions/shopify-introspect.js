// TEMPORARY. ?k=<runkey> — introspect inventory input types + fetch one inventoryItemId to test.
const { gql } = require('./_shopify');
const { guard } = require('./_runkey');
exports.handler = async (event) => {
  if (!(await guard(event)).ok) return { statusCode: 403, body: 'nope' };
  const out = {};
  try {
    for (const t of ['InventorySetQuantitiesInput','InventorySetQuantityInput']) {
      const d = await gql('query($n:String!){ __type(name:$n){ name inputFields{ name type{ kind name ofType{ kind name } } } } }', { n: t });
      out[t] = d.__type ? d.__type.inputFields.map(f => f.name + ':' + (f.type.name || (f.type.ofType && f.type.ofType.name) || f.type.kind)) : null;
    }
    const v = await gql('query{ productVariants(first:1){ nodes{ displayName inventoryItem{ id } inventoryQuantity } } }');
    out.sample = v.productVariants.nodes[0];
  } catch (e) { out.err = String(e.message || e); }
  return { statusCode: 200, headers: { 'Content-Type':'application/json','Cache-Control':'no-store' }, body: JSON.stringify(out, null, 1) };
};
