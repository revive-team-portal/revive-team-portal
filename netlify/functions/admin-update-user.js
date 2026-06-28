const { json, sb, requireAdmin } = require('./_supa');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const admin = await requireAdmin(event);
  if (!admin.ok) return json(admin.status || 403, { error: admin.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }

  const user_id = body.user_id;
  const full_name = (body.full_name || '').trim();
  const is_admin = !!body.is_admin;
  const active = body.active !== false;
  const apps = Array.isArray(body.apps) ? body.apps : [];
  const password = body.password || '';

  if (!user_id) return json(400, { error: 'Missing user.' });

  // Safeguard: an admin cannot strip their own admin rights or suspend themselves (avoids lockout).
  if (user_id === admin.callerId && (!is_admin || !active)) {
    return json(400, { error: "You can't remove your own admin access or suspend your own account." });
  }

  // 1. Optional password reset.
  if (password) {
    if (password.length < 6) return json(400, { error: 'Password must be at least 6 characters.' });
    const pres = await sb('/auth/v1/admin/users/' + user_id, {
      method: 'PUT',
      body: JSON.stringify({ password }),
    });
    if (!pres.ok) {
      const e = await pres.json().catch(() => ({}));
      return json(400, { error: e.msg || 'Could not reset the password.' });
    }
  }

  // 2. Update profile.
  await sb('/rest/v1/profiles?id=eq.' + user_id, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ full_name, is_admin, active }),
  });

  // 3. Replace app access (clear then re-add the ticked apps).
  await sb('/rest/v1/user_app_access?user_id=eq.' + user_id, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  if (apps.length) {
    const recs = apps.map((a) => ({ user_id, app_id: a }));
    await sb('/rest/v1/user_app_access', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(recs),
    });
  }

  return json(200, { ok: true });
};
