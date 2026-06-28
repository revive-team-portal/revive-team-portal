const { json, sb, requireAdmin } = require('./_supa');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const admin = await requireAdmin(event);
  if (!admin.ok) return json(admin.status || 403, { error: admin.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }

  const user_id = body.user_id;
  if (!user_id) return json(400, { error: 'Missing user.' });
  if (user_id === admin.callerId) return json(400, { error: "You can't delete your own account." });

  // Deleting the auth user cascades to profiles and user_app_access (FK on delete cascade).
  const dres = await sb('/auth/v1/admin/users/' + user_id, { method: 'DELETE' });
  if (!dres.ok) {
    const e = await dres.json().catch(() => ({}));
    return json(400, { error: e.msg || 'Could not delete the user.' });
  }

  return json(200, { ok: true });
};
