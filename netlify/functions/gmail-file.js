// Files a Gmail message into the "CRM Reviewed" label and removes it from the Inbox. Portal-gated (sales).
const { json, validatePortalUser } = require('./_portal');
const { getAccessToken } = require('./_gmail');
const LABEL_NAME = 'CRM Reviewed';
async function gapi(token, path, opts = {}) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { ...opts, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'sales');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }
  if (!body.messageId) return json(400, { error: 'No messageId.' });
  const at = await getAccessToken();
  if (!at.ok) return json(400, { error: at.error });

  const ll = await gapi(at.access_token, 'labels');
  let label = (ll.data.labels || []).find(l => l.name === LABEL_NAME);
  if (!label) {
    const cr = await gapi(at.access_token, 'labels', { method: 'POST', body: JSON.stringify({ name: LABEL_NAME, labelListVisibility: 'labelShow', messageListVisibility: 'show' }) });
    if (!cr.ok) return json(502, { error: (cr.data.error && cr.data.error.message) || 'Could not create label. (Reconnect Gmail to grant modify access.)' });
    label = cr.data;
  }
  const mod = await gapi(at.access_token, 'messages/' + body.messageId + '/modify', { method: 'POST', body: JSON.stringify({ addLabelIds: [label.id], removeLabelIds: ['INBOX', 'UNREAD'] }) });
  if (!mod.ok) return json(502, { error: (mod.data.error && mod.data.error.message) || 'Could not file the message. (Reconnect Gmail to grant modify access.)' });
  return json(200, { ok: true });
};
