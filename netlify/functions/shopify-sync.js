const { syncShopify } = require('./_shopifysync');
const { internalFetch } = require('./_runkey');
exports.handler = async () => {
  const end = new Date().toISOString().slice(0, 10);
  const d = new Date(); d.setUTCDate(d.getUTCDate() - 56); const start = d.toISOString().slice(0, 10);
  const base = process.env.URL || 'https://team.revive.co.nz';
  await internalFetch('catering-sync-background').catch(() => {});
  await internalFetch('heat-eat-sync-background').catch(() => {});
  try { const s = await syncShopify(start, end); console.log('shopify-sync', JSON.stringify(s)); return { statusCode: 200, body: JSON.stringify(s) }; }
  catch (e) { console.log('shopify-sync error', String(e && e.message || e)); return { statusCode: 500, body: String(e) }; }
};
