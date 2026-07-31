const { runSync } = require('./_tksync');
exports.handler = async () => {
  try { const s = await runSync(6); console.log('timekeeper-sync', JSON.stringify(s)); return { statusCode: 200, body: JSON.stringify(s) }; }
  catch (e) { console.log('timekeeper-sync error', String(e && e.message || e)); return { statusCode: 500, body: String(e) }; }
};
