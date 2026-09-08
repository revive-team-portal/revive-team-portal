// Hourly: send the "we're a bit busy" holding reply to tickets past the SLA.
// The engine itself skips weekends and anything outside the configured send window.
const { runHoldingReplies } = require('./_holdingreply');
exports.handler = async () => {
  try { const r = await runHoldingReplies({}); console.log('holding-reply', JSON.stringify(r)); return { statusCode:200, body: JSON.stringify(r) }; }
  catch (e) { console.log('holding-reply error', String(e)); return { statusCode:500, body: String(e) }; }
};
