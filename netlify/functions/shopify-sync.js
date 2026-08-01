const { syncShopify } = require('./_shopifysync');
exports.handler = async () => {
  const end = new Date().toISOString().slice(0, 10);
  const d = new Date(); d.setUTCDate(d.getUTCDate() - 56); const start = d.toISOString().slice(0, 10);
  try { const s = await syncShopify(start, end); console.log('shopify-sync', JSON.stringify(s)); return { statusCode: 200, body: JSON.stringify(s) }; }
  catch (e) { console.log('shopify-sync error', String(e && e.message || e)); return { statusCode: 500, body: String(e) }; }
};
