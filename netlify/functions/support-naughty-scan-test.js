// TEMP diag: runs a short resend-pass synchronously and returns the result or the error.
exports.handler = async () => {
  try {
    const { runResendScan } = require('./_naughtyscan');
    const r = await runResendScan(3);
    return { statusCode: 200, body: JSON.stringify(r) };
  } catch (e) { return { statusCode: 500, body: 'ERR: ' + String(e && (e.stack || e.message) || e) }; }
};
