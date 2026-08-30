// Staff identity layer for /me — a lighter tier than a portal login.
//
// A staff member has a 6-digit access_code (their personal /me link) and a PIN.
// The code identifies; the PIN authorises. A successful PIN issues a session
// token the browser stores; "remember this device" makes it long-lived.
//
// Used by: staff-auth.js, me-data.js. Portal-login apps keep using _portal.js.

const crypto = require('crypto');

const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;

const SHORT_SESSION_H = 8;        // shared device
const LONG_SESSION_D  = 180;      // "this is my phone"
const MAX_PIN_TRIES   = 5;
const LOCK_MINUTES    = 15;

function json(status, obj) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

// --- Supabase REST against a given schema -----------------------------------
async function db(path, opts = {}, schema = 'timeclock') {
  if (!APPS_KEY) throw new Error('Server not configured (APPS_SERVICE_ROLE_KEY).');
  const headers = {
    apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': schema, 'Content-Profile': schema, ...(opts.headers || {}),
  };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 300));
  return data;
}

// --- PIN hashing (scrypt, no npm dependency) --------------------------------
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}

function verifyPin(pin, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let candidate;
  try { candidate = crypto.scryptSync(String(pin), parts[1], 32); } catch { return false; }
  const expected = Buffer.from(parts[2], 'hex');
  if (expected.length !== candidate.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function validPin(pin) {
  return /^\d{4}$/.test(String(pin || ''));
}

// --- codes and tokens -------------------------------------------------------
// Random, non-sequential, never derived from the employee number.
function randomCode() {
  return String(crypto.randomInt(100000, 1000000));
}

async function generateUniqueCode() {
  for (let i = 0; i < 30; i++) {
    const code = randomCode();
    const hit = await db('staff?access_code=eq.' + code + '&select=id&limit=1');
    if (!hit.length) return code;
  }
  throw new Error('Could not allocate an access code.');
}

function newToken() { return crypto.randomBytes(32).toString('hex'); }
function tokenHash(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }

// --- lookups ----------------------------------------------------------------
const STAFF_COLS = 'id,name,email,active,is_manager,access_code,pin_hash,pin_set_at,pin_attempts,locked_until';

async function staffByCode(code) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const rows = await db('staff?access_code=eq.' + code + '&active=eq.true&select=' + STAFF_COLS + '&limit=1');
  return rows[0] || null;
}

function lockedFor(staff) {
  if (!staff || !staff.locked_until) return 0;
  const ms = new Date(staff.locked_until).getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 60000) : 0;
}

// --- sign in ----------------------------------------------------------------
async function startSession(staffId, remembered, userAgent) {
  const token = newToken();
  const expires = new Date(Date.now() + (remembered ? LONG_SESSION_D * 864e5 : SHORT_SESSION_H * 36e5));
  await db('staff_session', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      staff_id: staffId, token_hash: tokenHash(token), remembered: !!remembered,
      user_agent: String(userAgent || '').slice(0, 300), expires_at: expires.toISOString(),
    }),
  });
  return { token, expires_at: expires.toISOString() };
}

async function signIn(code, pin, remembered, userAgent) {
  const staff = await staffByCode(code);
  // Same generic message whether the code or the PIN is wrong.
  if (!staff) return { ok: false, status: 401, error: 'That link or PIN is not right. Check with your manager.' };

  const mins = lockedFor(staff);
  if (mins) return { ok: false, status: 429, error: 'Too many tries. Try again in ' + mins + ' minute' + (mins === 1 ? '' : 's') + '.' };

  if (!staff.pin_hash) return { ok: false, status: 409, error: 'No PIN set yet.', needsSetup: true };

  if (!verifyPin(pin, staff.pin_hash)) {
    const tries = (staff.pin_attempts || 0) + 1;
    const patch = { pin_attempts: tries };
    if (tries >= MAX_PIN_TRIES) {
      patch.locked_until = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
      patch.pin_attempts = 0;
    }
    await db('staff?id=eq.' + staff.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    if (patch.locked_until) return { ok: false, status: 429, error: 'Too many tries. Try again in ' + LOCK_MINUTES + ' minutes.' };
    return { ok: false, status: 401, error: 'That PIN is not right. ' + (MAX_PIN_TRIES - tries) + ' tries left.' };
  }

  if (staff.pin_attempts) {
    await db('staff?id=eq.' + staff.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ pin_attempts: 0, locked_until: null }) });
  }
  const session = await startSession(staff.id, remembered, userAgent);
  return { ok: true, staff: publicStaff(staff), ...session };
}

async function setFirstPin(code, pin, remembered, userAgent) {
  if (!validPin(pin)) return { ok: false, status: 400, error: 'Your PIN must be 4 digits.' };
  const staff = await staffByCode(code);
  if (!staff) return { ok: false, status: 401, error: 'That link is not right. Check with your manager.' };
  if (staff.pin_hash) return { ok: false, status: 409, error: 'A PIN is already set. Ask a manager to reset it.' };
  await db('staff?id=eq.' + staff.id, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ pin_hash: hashPin(pin), pin_set_at: new Date().toISOString(), pin_attempts: 0, locked_until: null }),
  });
  const session = await startSession(staff.id, remembered, userAgent);
  return { ok: true, staff: publicStaff(staff), ...session };
}

function publicStaff(s) {
  return { id: s.id, name: s.name, is_manager: !!s.is_manager };
}

// --- session check ----------------------------------------------------------
// Gate for every staff-facing endpoint. Returns { ok, staff } or { ok:false, status, error }.
async function requireStaff(event) {
  const token = (event.headers['x-staff-token'] || event.headers['X-Staff-Token'] || '').trim();
  if (!token) return { ok: false, status: 401, error: 'Please sign in again.' };
  const rows = await db('staff_session?token_hash=eq.' + tokenHash(token) + '&select=id,staff_id,expires_at&limit=1');
  const sess = rows[0];
  if (!sess) return { ok: false, status: 401, error: 'Please sign in again.' };
  if (new Date(sess.expires_at).getTime() < Date.now()) {
    await db('staff_session?id=eq.' + sess.id, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    return { ok: false, status: 401, error: 'Your session has expired. Please enter your PIN again.' };
  }
  const staff = (await db('staff?id=eq.' + sess.staff_id + '&active=eq.true&select=id,name,email,is_manager&limit=1'))[0];
  if (!staff) return { ok: false, status: 403, error: 'No access.' };
  // Touch last_seen, but never let it fail the request.
  db('staff_session?id=eq.' + sess.id, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ last_seen: new Date().toISOString() }),
  }).catch(() => {});
  return { ok: true, staff: publicStaff(staff), sessionId: sess.id };
}

async function signOut(event) {
  const token = (event.headers['x-staff-token'] || event.headers['X-Staff-Token'] || '').trim();
  if (!token) return;
  await db('staff_session?token_hash=eq.' + tokenHash(token), { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => {});
}

async function signOutAll(staffId) {
  await db('staff_session?staff_id=eq.' + staffId, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

// Housekeeping — cheap enough to call opportunistically.
async function purgeExpired() {
  await db('staff_session?expires_at=lt.' + new Date().toISOString(), { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => {});
}

module.exports = {
  APPS_URL, APPS_KEY, json, db,
  hashPin, verifyPin, validPin,
  generateUniqueCode, staffByCode, publicStaff,
  signIn, setFirstPin, requireStaff, signOut, signOutAll, purgeExpired,
};
