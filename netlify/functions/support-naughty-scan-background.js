// Background worker: scan recently-dispatched orders and flag undelivered ones into the
// naughty list. Up to 15 min (eShip is rate-limited). Triggered by support-naughty-scan
// and by a daily schedule.
const { runScan } = require('./_naughtyscan');
exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  try {
    const r = await runScan({ days: Number(qs.days) || 35 });
    console.log('naughty-scan', JSON.stringify(r));
    return { statusCode: 200, body: JSON.stringify(r) };
  } catch (e) {
    console.log('naughty-scan error', String((e && e.message) || e));
    try { const { rest } = require('./_appsdb'); await rest('naughty_scan?id=eq.1', { method:'PATCH', headers:{Prefer:'return=minimal'}, body: JSON.stringify({ status:'error', summary:{ error:String((e&&e.message)||e).slice(0,240) }, updated_at:new Date().toISOString() }) }); } catch (e2) {}
    return { statusCode: 500, body: String((e && e.message) || e) };
  }
};
