// TEMP diagnostic: shows which Admin API scopes the portal's Shopify token actually has,
// and which app (client id prefix) it belongs to. No secrets returned. Remove after use.
const { getToken, STORE, API_VER } = require('./_shopify');
exports.handler = async () => {
  try {
    const token = await getToken();
    const res = await fetch('https://' + STORE + '/admin/oauth/access_scopes.json', {
      headers: { 'X-Shopify-Access-Token': token },
    });
    const d = await res.json().catch(() => ({}));
    const scopes = (d.access_scopes || []).map(s => s.handle).sort();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store: STORE, api: API_VER, client_id_prefix: String(process.env.SHOPIFY_CLIENT_ID||'').slice(0,6), has_write_inventory: scopes.includes('write_inventory'), scopes }) };
  } catch (e) {
    return { statusCode: 500, body: String(e.message || e) };
  }
};
