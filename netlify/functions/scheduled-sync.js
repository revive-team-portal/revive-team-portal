// Runs the inbox sync + reconcile on a schedule (see netlify.toml). No auth: server-side only.
const { runInboxSync } = require('./_ingest');
exports.handler = async () => {
  try { const r = await runInboxSync({}); console.log('scheduled-sync', JSON.stringify(r)); return { statusCode: 200, body: JSON.stringify(r) }; }
  catch (e) { console.log('scheduled-sync error', String(e && e.message || e)); return { statusCode: 500, body: String(e) }; }
};
