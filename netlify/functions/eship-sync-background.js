// Nightly per-order shipping-cost capture from Starshipit. Background function
// (up to 15 min) because Starshipit is rate-limited to ~1 req/sec and cost is only
// on the per-order detail. Grabs orders shipped in the last ~12 days.
const { syncShipping } = require('./_eshipsync');
exports.handler = async () => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - 12); const since = d.toISOString().slice(0, 10);
  try { const s = await syncShipping(since, 500); console.log('eship-sync', JSON.stringify(s)); return { statusCode: 200, body: JSON.stringify(s) }; }
  catch (e) { console.log('eship-sync error', String(e && e.message || e)); return { statusCode: 500, body: String(e) }; }
};
