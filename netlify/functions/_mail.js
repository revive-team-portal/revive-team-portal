// Unified email send. Uses Resend (resend.com) when RESEND_KEY is set on this site.
// If Resend errors (e.g. unverified from-domain, bad key, quota), it falls back to the
// shared Gmail mailbox so mail always goes out — and emails an alert about the fallback.
// `to` may be a comma-separated list.
const RESEND_KEY = process.env.RESEND_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'Revive Cafe <noreply@revivealicious.com>';
const ALERT_TO = process.env.MAIL_ALERT_TO || 'jeremy@revive.co.nz';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

async function sendViaResend({ to, subject, html, text }) {
  const toList = String(to || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!toList.length) return { ok: false, error: 'No recipients.' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM, to: toList, subject, html, text }) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: (d && (d.message || (d.error && (d.error.message || d.error)) )) || ('Resend ' + res.status) };
  return { ok: true, id: d.id, from: RESEND_FROM, via: 'resend' };
}

async function sendViaGmail(opts) {
  const { sendMail: gmailSend } = require('./_gmail');
  const r = await gmailSend(opts);
  if (r.ok) r.via = 'gmail';
  return r;
}

async function sendMail(opts) {
  if (RESEND_KEY && !opts._isAlert) {
    const r = await sendViaResend(opts);
    if (r.ok) return r;
    console.warn('Resend send failed, falling back to Gmail:', r.error);
    const g = await sendViaGmail(opts);
    // best-effort alert (sent via Gmail, since Resend is the thing that's broken)
    try {
      await sendViaGmail({
        _isAlert: true,
        to: ALERT_TO,
        subject: '⚠️ Revive email is using the Gmail fallback (Resend failed)',
        html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#243029">
          <p>Heads up — an email just went out via the <strong>Gmail fallback</strong> because <strong>Resend failed</strong>. Delivery still worked, but Resend needs attention.</p>
          <p><strong>Resend error:</strong> ${esc(r.error)}</p>
          <p style="color:#6b7b72;font-size:13px"><strong>Affected message</strong><br>Subject: ${esc(opts.subject)}<br>To: ${esc(opts.to)}</p>
          <p style="font-size:13px">Common causes: sending domain unverified, wrong/rotated API key, or monthly quota hit. Check <a href="https://resend.com/domains">resend.com/domains</a> and your API key.</p>
        </div>`,
        text: `Revive email used the Gmail fallback because Resend failed: ${r.error}. Affected: "${opts.subject}" to ${opts.to}. Check resend.com/domains and your API key.`,
      });
    } catch (e) { console.warn('Could not send fallback alert:', e && e.message); }
    return g;
  }
  return sendViaGmail(opts);
}

module.exports = { sendMail };
