// Sign-in for /me. Deliberately NOT portal-gated — staff have no portal login.
// The access code identifies a person (name only); the PIN authorises. No staff
// data is returned until a PIN has been verified and a session token issued.

const { json, staffByCode, signIn, setFirstPin, signOut, requireStaff, signOutAll, purgeExpired } = require('./_staffauth');

// Small constant-ish delay so the code space can't be swept quickly.
const slow = () => new Promise(r => setTimeout(r, 140 + Math.floor(Math.random() * 160)));

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }

  const action = body.action;
  const ua = event.headers['user-agent'] || '';

  try {
    if (action === 'lookup') {
      await slow();
      const staff = await staffByCode(body.code);
      if (!staff) return json(404, { error: 'We could not find that link. Check with your manager.' });
      return json(200, { name: staff.name, needsSetup: !staff.pin_hash });
    }

    if (action === 'set_pin') {
      await slow();
      const r = await setFirstPin(body.code, body.pin, body.remember, ua);
      if (!r.ok) return json(r.status, { error: r.error });
      purgeExpired();
      return json(200, { staff: r.staff, token: r.token, expires_at: r.expires_at });
    }

    if (action === 'verify') {
      await slow();
      const r = await signIn(body.code, body.pin, body.remember, ua);
      if (!r.ok) return json(r.status, { error: r.error, needsSetup: !!r.needsSetup });
      return json(200, { staff: r.staff, token: r.token, expires_at: r.expires_at });
    }

    if (action === 'signout') {
      await signOut(event);
      return json(200, { ok: true });
    }

    if (action === 'signout_all') {
      const auth = await requireStaff(event);
      if (!auth.ok) return json(auth.status, { error: auth.error });
      await signOutAll(auth.staff.id);
      return json(200, { ok: true });
    }

    if (action === 'ping') {
      const auth = await requireStaff(event);
      if (!auth.ok) return json(auth.status, { error: auth.error });
      return json(200, { staff: auth.staff });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (e) {
    return json(500, { error: String(e.message || e).slice(0, 300) });
  }
};

function cors() {
  return { 'Access-Control-Allow-Origin': 'https://team.revive.co.nz', 'Access-Control-Allow-Headers': 'Content-Type, X-Staff-Token', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
}
