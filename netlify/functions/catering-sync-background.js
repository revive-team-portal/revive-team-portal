const { syncCatering } = require('./_shopifycatering');
exports.handler = async () => {
  const end = new Date().toISOString().slice(0, 10);
  const d = new Date(); d.setUTCDate(d.getUTCDate() - 70); const start = d.toISOString().slice(0, 10);
  try { const s = await syncCatering(start, end); console.log('catering-sync', JSON.stringify(s)); return { statusCode: 200, body: JSON.stringify(s) }; }
  catch (e) { console.log('catering-sync error', String(e && e.message || e)); return { statusCode: 500, body: String(e) }; }
};
