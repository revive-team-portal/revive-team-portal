// "Put back in stock" — stops Shopify from tracking stock for an inventory item, so the
// variant becomes available for sale again. Portal-gated (support). Requires the Shopify
// app to have write_inventory scope.
const { json, validatePortalUser } = require('./_portal');
const { gql } = require('./_shopify');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  const id = body.inventoryItemId;
  if (!id) return json(400, { error: 'Missing inventoryItemId.' });
  try {
    const d = await gql(
      'mutation($id:ID!){ inventoryItemUpdate(id:$id, input:{ tracked:false }){ inventoryItem { id tracked } userErrors { field message } } }',
      { id }
    );
    const res = d.inventoryItemUpdate || {};
    const errs = res.userErrors || [];
    if (errs.length) return json(422, { error: errs.map(e => e.message).join('; ') });
    return json(200, { ok: true, tracked: res.inventoryItem ? res.inventoryItem.tracked : false });
  } catch (e) {
    const msg = String(e.message || e);
    if (/access denied|not approved|scope/i.test(msg)) {
      return json(403, { error: 'Shopify write_inventory permission is needed. Add write_inventory to the app scopes and reinstall.' });
    }
    return json(502, { error: msg });
  }
};
