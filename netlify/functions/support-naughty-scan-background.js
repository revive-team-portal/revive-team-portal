// Background worker: (1) courier scan of recently-dispatched orders, (2) zero-value resend
// pairing to surface destroyed originals. Up to 15 min. Triggered on demand + daily.
const { runScan, runResendScan } = require('./_naughtyscan');
const { rest } = require('./_appsdb');
exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const days = Number(qs.days) || 35;
  try {
    const c = await runScan({ days });
    let rp = { resends: 0, flagged: 0, pairs: [] };
    try { rp = await runResendScan(days); } catch (e) { console.log('resend-pass error', String(e && e.message || e)); }
    // merge resend results into the scan status row
    try {
      const cur = await rest('naughty_scan?id=eq.1&select=summary,flagged');
      const summary = (cur && cur[0] && cur[0].summary) || {};
      summary.resends_scanned = rp.resends; summary.resend_pairs = rp.pairs;
      await rest('naughty_scan?id=eq.1', { method:'PATCH', headers:{Prefer:'return=minimal'}, body: JSON.stringify({
        flagged: (Number((cur && cur[0] && cur[0].flagged) || 0)) + (rp.flagged || 0),
        summary, updated_at: new Date().toISOString() }) });
    } catch (e) {}
    const out = { courier: c, resend: rp };
    console.log('naughty-scan', JSON.stringify(out));
    return { statusCode: 200, body: JSON.stringify(out) };
  } catch (e) {
    console.log('naughty-scan error', String((e && e.message) || e));
    try { await rest('naughty_scan?id=eq.1', { method:'PATCH', headers:{Prefer:'return=minimal'}, body: JSON.stringify({ status:'error', summary:{ error:String((e&&e.message)||e).slice(0,240) }, updated_at:new Date().toISOString() }) }); } catch (e2) {}
    return { statusCode: 500, body: String((e && e.message) || e) };
  }
};
