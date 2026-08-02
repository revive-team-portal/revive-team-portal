const { syncMeta } = require('./_metasync');
exports.handler = async () => {
  const end = new Date().toISOString().slice(0, 10);
  const d = new Date(); d.setUTCDate(d.getUTCDate() - 56); const start = d.toISOString().slice(0, 10);
  try { const s = await syncMeta(start, end); console.log('meta-sync', JSON.stringify(s)); return { statusCode: 200, body: JSON.stringify(s) }; }
  catch (e) { console.log('meta-sync error', String(e && e.message || e)); return { statusCode: 500, body: String(e) }; }
};
