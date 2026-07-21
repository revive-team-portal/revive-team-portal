// Fetch a Gmail attachment (base64url) for the cafe@ mailbox. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { getAccessToken } = require('./_gmail');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  if (!body.messageId || !body.attachmentId) return json(400, { error: 'messageId + attachmentId required.' });
  const at = await getAccessToken('cafe');
  if (!at.ok) return json(400, { error: at.error });
  try {
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent(body.messageId)+'/attachments/'+encodeURIComponent(body.attachmentId), { headers:{ Authorization:'Bearer '+at.access_token } });
    const d = await r.json().catch(()=>({}));
    if (!r.ok || !d.data) return json(502, { error: 'Attachment fetch failed.' });
    return json(200, { dataBase64: d.data, size: d.size });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
