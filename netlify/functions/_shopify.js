// Shared Shopify Admin API helper for the support portal.
// Uses the client-credentials grant (Dev Dashboard app) to mint a 24h Admin API
// token, cached in warm-container module scope. Secrets are server-side only.
const STORE   = process.env.SHOPIFY_STORE_DOMAIN;          // e.g. revive-cafe.myshopify.com
const CID     = process.env.SHOPIFY_CLIENT_ID;
const SECRET  = process.env.SHOPIFY_CLIENT_SECRET;
const API_VER = '2026-07';

let _tok = null;      // { access_token, exp }

async function getToken() {
  if (_tok && Date.now() < _tok.exp - 60000) return _tok.access_token;
  if (!STORE || !CID || !SECRET) throw new Error('Shopify not configured (client id/secret/domain).');
  const res = await fetch('https://' + STORE + '/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CID, client_secret: SECRET }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) {
    const msg = (d && (d.error_description || d.error)) || ('HTTP ' + res.status);
    throw new Error('Shopify token exchange failed: ' + msg + '. Is the app installed on ' + STORE + '?');
  }
  _tok = { access_token: d.access_token, exp: Date.now() + (Number(d.expires_in || 86000) * 1000) };
  return _tok.access_token;
}

async function gql(query, variables) {
  const token = await getToken();
  const res = await fetch('https://' + STORE + '/admin/api/' + API_VER + '/graphql.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const d = await res.json().catch(() => ({}));
  if (d.errors) throw new Error('Shopify GraphQL error: ' + JSON.stringify(d.errors).slice(0, 300));
  return d.data;
}

module.exports = { getToken, gql, STORE, API_VER };
