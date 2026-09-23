// TEMPORARY. ?k=<runkey> — explore how Heat & Eat meals are classified on Shopify.
const { gql } = require('./_shopify');
const { guard } = require('./_runkey');
exports.handler = async (event) => {
  if (!(await guard(event)).ok) return { statusCode: 403, body: 'nope' };
  const out = {};
  try {
    const c = await gql('query{ collections(first:60){ nodes{ title handle productsCount{ count } } } }');
    out.collections = (c.collections.nodes||[]).map(x=>x.title+' ('+x.handle+', '+((x.productsCount&&x.productsCount.count)||0)+')');
    // product types
    const pt = await gql('query{ shop{ id } productTypes(first:200){ edges{ node } } }').catch(()=>null);
    if (pt && pt.productTypes) out.productTypes = pt.productTypes.edges.map(e=>e.node).filter(Boolean);
    // products matching heat/eat/meal
    const p = await gql('query{ products(first:40, query:"title:*heat* OR title:*meal* OR product_type:*meal*"){ nodes{ title productType tags totalInventory } } }');
    out.matches = (p.products.nodes||[]).map(x=>({t:x.title, type:x.productType, tags:x.tags}));
  } catch (e) { out.err = String(e.message||e); }
  return { statusCode: 200, headers:{'Content-Type':'application/json','Cache-Control':'no-store'}, body: JSON.stringify(out, null, 1) };
};
