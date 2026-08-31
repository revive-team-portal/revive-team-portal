// Xero OAuth redirect target. Xero sends the user back here with ?code and ?state.
// The state was minted by recon-data (which is behind the portal login) and stored
// server-side, so a code arriving without a matching, unexpired state is rejected --
// that is what stops someone else's Xero org being attached to our portal.
const X = require('./_xero');

function page(title, detail, ok) {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Xero — Revive</title>
<link rel="stylesheet" href="/chrome.css">
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#f5f5f4;
margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#fff;border:1px solid #e7e5e4;border-radius:14px;padding:32px;max-width:460px;text-align:center}
h1{font-size:19px;margin:0 0 10px;color:${ok ? '#16543f' : '#9f1239'}}p{color:#57534e;font-size:14px;line-height:1.5;margin:0 0 20px}
a{display:inline-block;background:#16543f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:9px;font-weight:600;font-size:14px}</style>
</head><body><div class="card"><h1>${esc(title)}</h1><p>${esc(detail)}</p>
<a href="/recon/">Back to Recon</a></div></body></html>`;
}

exports.handler = async (event) => {
  const qp = (event.queryStringParameters) || {};
  const html = (code, body) => ({ statusCode: code, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body });

  if (qp.error) {
    return html(200, page('Xero did not connect', 'Xero returned: ' + qp.error + '. Nothing was changed.', false));
  }
  if (!qp.code || !qp.state) {
    return html(400, page('Xero did not connect', 'That link is missing its authorisation code. Start again from the Recon app.', false));
  }

  try {
    const row = await X.getRow();
    if (!row || !row.state || row.state !== qp.state) {
      return html(403, page('Xero did not connect', 'This authorisation did not match a request from the Recon app, so it was rejected. Start again from Recon.', false));
    }
    // States are single-use and short-lived.
    const age = row.state_at ? (Date.now() - new Date(row.state_at).getTime()) : Infinity;
    if (age > 15 * 60 * 1000) {
      await X.saveRow({ state: null });
      return html(403, page('That link expired', 'The connection request timed out. Start again from the Recon app.', false));
    }

    const res = await X.exchangeCode(qp.code);
    return html(200, page('Xero connected',
      'Connected to ' + res.tenant_name + '. Recon can now pull bank statement lines automatically.', true));
  } catch (e) {
    return html(500, page('Xero did not connect', String(e.message || e).slice(0, 300), false));
  }
};
