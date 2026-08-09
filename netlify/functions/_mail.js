// Unified email send. Uses Resend (resend.com) when RESEND_KEY is set on this site,
// otherwise falls back to the shared Gmail mailbox. `to` may be a comma-separated list.
const RESEND_KEY = process.env.RESEND_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'Revive Cafe <reports@revive.co.nz>';
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
async function sendMail(opts) {
  if (RESEND_KEY) return sendViaResend(opts);
  const { sendMail: gmailSend } = require('./_gmail');
  const r = await gmailSend(opts);
  if (r.ok) r.via = 'gmail';
  return r;
}
module.exports = { sendMail };
