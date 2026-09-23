const { gql } = require('./_shopify');
const { guard } = require('./_runkey');
exports.handler = async (event) => {
  if (!(await guard(event)).ok) return { statusCode: 403, body: 'nope' };
  try {
    const d = await gql('query{ __schema{ directives{ name locations args{ name type{ kind name ofType{ kind name } } } } } }');
    const idem = d.__schema.directives.filter(x => /idempot/i.test(x.name));
    return { statusCode: 200, headers: { 'Content-Type':'application/json','Cache-Control':'no-store' }, body: JSON.stringify(idem, null, 1) };
  } catch (e) { return { statusCode: 200, headers:{'Cache-Control':'no-store'}, body: JSON.stringify({ err: String(e.message || e) }) }; }
};
