// Reports which addresses the cafe mailbox is allowed to send as, so we know
// whether job overflow email can go out as operations@revive.co.nz.
// Read-only: it sends nothing.
const { getAccessToken } = require('./_gmail');

exports.handler = async () => {
  const at = await getAccessToken('cafe');
  if (!at.ok) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: at.error }) };
  }
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs', {
    headers: { Authorization: 'Bearer ' + at.access_token }
  });
  const d = await res.json().catch(() => ({}));
  const aliases = (d.sendAs || []).map(a => ({
    email: a.sendAsEmail,
    primary: !!a.isPrimary,
    verification: a.verificationStatus || (a.isPrimary ? 'primary' : 'unknown')
  }));
  const wanted = aliases.find(a =>
    (a.email || '').toLowerCase() === 'operations@revive.co.nz' &&
    (a.verification === 'accepted' || a.primary));
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mailbox: at.email, canSendAsPreferred: !!wanted, aliases }, null, 2)
  };
};
