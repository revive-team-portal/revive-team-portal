const { json, sb, requireAdmin } = require('./_supa');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const admin = await requireAdmin(event);
  if (!admin.ok) return json(admin.status || 403, { error: admin.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }

  const email = (body.email || '').trim();
  const password = body.password || '';
  const full_name = (body.full_name || '').trim();
  const is_admin = !!body.is_admin;
  const active = body.active !== false;
  const apps = Array.isArray(body.apps) ? body.apps : [];

  if (!email) return json(400, { error: 'Email is required.' });
  if (!password || password.length < 6) return json(400, { error: 'Password must be at least 6 characters.' });

  // 1. Create the auth user (email pre-confirmed so they can sign in immediately).
  const cres = await sb('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name } }),
  });
  const cuser = await cres.json().catch(() => ({}));
  if (!cres.ok) {
    const m = cuser.msg || cuser.error_description || cuser.error || '';
    const friendly = /already|registered|exists/i.test(m) ? 'A user with that email already exists.' : (m || 'Could not create the user.');
    return json(400, { error: friendly });
  }
  const uid = cuser.id;

  // 2. Update the auto-created profile row.
  await sb('/rest/v1/profiles?id=eq.' + uid, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ full_name, is_admin, active, email }),
  });

  // 3. Grant app access.
  if (apps.length) {
    const recs = apps.map((a) => ({ user_id: uid, app_id: a }));
    await sb('/rest/v1/user_app_access', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(recs),
    });
  }

  return json(200, { ok: true, id: uid });
};
