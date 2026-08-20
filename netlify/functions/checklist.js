// Checklist app data API. All reads/writes use the Apps service-role key (RLS bypassed)
// so the browser never touches the checklist schema directly.
// Gated by portal auth + 'checklist' app access. The cafe iPad/iPhone signs into the
// portal once and stays signed in; individual staff sign off by tapping their name.

const { json, validatePortalUser } = require('./_portal');

const APPS_URL   = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY   = process.env.APPS_SERVICE_ROLE_KEY;
const PORTAL_URL = 'https://zpcbtfdjcsbdeqnizrpr.supabase.co';
const PORTAL_KEY = process.env.PORTAL_SERVICE_ROLE_KEY;
const BUCKET     = 'checklist-photos';

async function db(path, opts = {}) {
  const headers = {
    apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'checklist', 'Content-Profile': 'checklist', ...(opts.headers || {}),
  };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 300));
  return data;
}

async function isManager(userId) {
  const p = await fetch(PORTAL_URL + '/rest/v1/profiles?id=eq.' + userId + '&select=is_admin,full_name', {
    headers: { apikey: PORTAL_KEY, Authorization: 'Bearer ' + PORTAL_KEY },
  }).then(r => r.json()).catch(() => []);
  if (p && p[0] && p[0].is_admin) return true;
  const a = await fetch(PORTAL_URL + '/rest/v1/user_app_access?user_id=eq.' + userId + '&app_id=eq.checklist&select=role', {
    headers: { apikey: PORTAL_KEY, Authorization: 'Bearer ' + PORTAL_KEY },
  }).then(r => r.json()).catch(() => []);
  return !!(a && a[0] && (a[0].role === 'supervisor' || a[0].role === 'manager'));
}

const NZ = 'Pacific/Auckland';
function nzDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: NZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d ? new Date(d) : new Date());
}
function nzWeekday(dateStr) {
  // 0 = Sunday .. 6 = Saturday, for a YYYY-MM-DD string
  const [y, m, dd] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
}
function addDays(dateStr, n) {
  const [y, m, dd] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, dd + n));
  return t.toISOString().slice(0, 10);
}
function routineRunsToday(r, dateStr) {
  const wd = nzWeekday(dateStr);
  const dom = Number(dateStr.slice(8, 10));
  if (r.schedule === 'daily') return true;
  if (r.schedule === 'weekday') return wd >= 1 && wd <= 5;
  if (r.schedule === 'friday') return wd === 5;
  if (r.schedule === 'monthly') return dom <= 7 && wd >= 1 && wd <= 5; // first working week
  return true;
}
function publicUrl(path) {
  return APPS_URL + '/storage/v1/object/public/' + BUCKET + '/' + path;
}

async function uploadPhoto(dataUrl, prefix, day) {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) throw new Error('Bad image data.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 7 * 1024 * 1024) throw new Error('Photo too large.');
  const ext = m[1].includes('png') ? 'png' : 'jpg';
  const path = day + '/' + prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  const res = await fetch(APPS_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
    method: 'POST',
    headers: { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': m[1], 'x-upsert': 'true' },
    body: buf,
  });
  if (!res.ok) throw new Error('Upload failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return path;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!APPS_KEY || !PORTAL_KEY) return json(500, { error: 'Server not configured.' });

  const auth = await validatePortalUser(event, 'checklist');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  const action = body.action;
  const day = body.day || nzDate();
  const manager = await isManager(auth.user.id);
  const needManager = () => { if (!manager) throw new Error('Manager access required.'); };

  try {
    // ---------------------------------------------------------------- kiosk
    if (action === 'bootstrap') {
      const [staff, routines, tasks, units, wasteItems, completions, assignments, temps, flags, cas, waste, handTod, handPrev] = await Promise.all([
        db('staff?select=*&active=eq.true&order=sort,name'),
        db('routines?select=*&active=eq.true&order=sort'),
        db('tasks?select=*&active=eq.true&order=sort'),
        db('units?select=*&active=eq.true&order=kind,sort'),
        db('waste_items?select=*&active=eq.true&order=sort'),
        db('completions?select=*&day=eq.' + day),
        db('assignments?select=*&day=eq.' + day),
        db('temp_readings?select=*&day=eq.' + day),
        db('flags?select=*&resolved=eq.false&order=created_at.desc&limit=20'),
        db('corrective_actions?select=*&resolved=eq.false&order=created_at.desc&limit=20'),
        db('waste_log?select=*&day=eq.' + day),
        db('handover?select=*&day=eq.' + day),
        db('handover?select=*&day=lt.' + day + '&order=day.desc&limit=1'),
      ]);
      const byRoutine = {};
      tasks.forEach(t => { (byRoutine[t.routine_id] = byRoutine[t.routine_id] || []).push(t); });
      const todays = routines
        .filter(r => routineRunsToday(r, day))
        .map(r => ({ ...r, tasks: byRoutine[r.id] || [] }));
      return json(200, {
        day, isManager: manager, staff, units, wasteItems,
        routines: todays, allRoutines: routines,
        completions, assignments, temps, waste,
        flagsOpen: flags, correctiveOpen: cas,
        handoverToday: handTod[0] || null,
        handoverPrev: handPrev[0] || null,
      });
    }

    if (action === 'assign') {
      const row = { day, routine_id: body.routine_id, staff_id: body.staff_id || null };
      const r = await db('assignments?on_conflict=day,routine_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(row),
      });
      return json(200, { assignment: r[0] });
    }

    if (action === 'complete') {
      let photo_path = null;
      if (body.photo) photo_path = await uploadPhoto(body.photo, 'task', day);
      const row = {
        day, task_id: body.task_id, routine_id: body.routine_id || null,
        done: body.done !== false, value: body.value === '' || body.value === undefined ? null : Number(body.value),
        note: body.note || null, photo_path,
        staff_name: body.staff_name || null, device: body.device || null,
      };
      const r = await db('completions?on_conflict=day,task_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(row),
      });
      if (photo_path) {
        await db('photos', { method: 'POST', body: JSON.stringify({ day, kind: body.photo_kind || 'evidence', slot: body.slot || null, path: photo_path, staff_name: body.staff_name || null }) });
      }
      return json(200, { completion: r[0], url: photo_path ? publicUrl(photo_path) : null });
    }

    if (action === 'complete_many') {
      const rows = (body.items || []).map(i => ({
        day, task_id: i.task_id, routine_id: body.routine_id || null, done: true,
        staff_name: body.staff_name || null, device: body.device || null,
      }));
      if (!rows.length) return json(200, { completions: [] });
      const r = await db('completions?on_conflict=day,task_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(rows),
      });
      return json(200, { completions: r });
    }

    if (action === 'uncomplete') {
      await db('completions?day=eq.' + day + '&task_id=eq.' + body.task_id, { method: 'DELETE' });
      return json(200, { ok: true });
    }

    if (action === 'save_temps') {
      const slot = body.slot || 'check';
      const readings = body.readings || [];
      for (const r of readings) {
        await db('temp_readings?day=eq.' + day + '&slot=eq.' + encodeURIComponent(slot) + '&unit_code=eq.' + encodeURIComponent(r.unit_code), { method: 'DELETE' });
      }
      if (readings.length) {
        await db('temp_readings', {
          method: 'POST',
          body: JSON.stringify(readings.map(r => ({
            day, slot, unit_code: r.unit_code, unit_name: r.unit_name,
            reading: r.reading === '' || r.reading === null ? null : Number(r.reading),
            passed: r.passed, staff_name: body.staff_name || null,
          }))),
        });
      }
      return json(200, { ok: true });
    }

    if (action === 'corrective') {
      let photo_path = null;
      if (body.photo) photo_path = await uploadPhoto(body.photo, 'corrective', day);
      const r = await db('corrective_actions', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          day, source: body.source || null, problem: body.problem, action: body.action_taken || null,
          detail: body.detail || null, photo_path, staff_name: body.staff_name || null,
        }),
      });
      return json(200, { corrective: r[0] });
    }

    if (action === 'flag') {
      let photo_path = null;
      if (body.photo) photo_path = await uploadPhoto(body.photo, 'flag', day);
      const r = await db('flags', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ day, message: body.message, photo_path, staff_name: body.staff_name || null }),
      });
      return json(200, { flag: r[0] });
    }

    if (action === 'save_waste') {
      const rows = (body.rows || []).map(r => ({
        day, item_id: r.item_id, item_name: r.item_name,
        left_qty: Number(r.left_qty) || 0, waste_qty: Number(r.waste_qty) || 0,
        cost: Number(r.cost) || 0, staff_name: body.staff_name || null,
      }));
      if (rows.length) {
        await db('waste_log?on_conflict=day,item_id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify(rows),
        });
      }
      return json(200, { ok: true });
    }

    if (action === 'save_handover') {
      const r = await db('handover?on_conflict=day', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ day, note: body.note || '', staff_name: body.staff_name || null }),
      });
      return json(200, { handover: r[0] });
    }

    // -------------------------------------------------------------- manager
    if (action === 'dashboard') {
      const from = body.from || addDays(day, -29);
      const [routines, tasks, comps, temps, flags, cas, waste, wasteItems, photos, handovers] = await Promise.all([
        db('routines?select=*&active=eq.true&order=sort'),
        db('tasks?select=id,routine_id,title,killer&active=eq.true'),
        db('completions?select=day,task_id,routine_id,staff_name,created_at&day=gte.' + from + '&day=lte.' + day),
        db('temp_readings?select=*&day=gte.' + from + '&day=lte.' + day + '&order=day,created_at'),
        db('flags?select=*&order=created_at.desc&limit=60'),
        db('corrective_actions?select=*&order=created_at.desc&limit=60'),
        db('waste_log?select=*&day=gte.' + from + '&day=lte.' + day),
        db('waste_items?select=*&order=sort'),
        db('photos?select=*&day=gte.' + from + '&kind=in.(cabinet,pest)&order=created_at.desc&limit=200'),
        db('handover?select=*&day=gte.' + from + '&order=day.desc'),
      ]);
      return json(200, {
        day, from, routines, tasks, completions: comps, temps, flags, correctives: cas,
        waste, wasteItems, handovers,
        photos: photos.map(p => ({ ...p, url: publicUrl(p.path) })),
      });
    }

    if (action === 'resolve') {
      const table = body.kind === 'flag' ? 'flags' : 'corrective_actions';
      await db(table + '?id=eq.' + body.id, {
        method: 'PATCH',
        body: JSON.stringify({ resolved: true, resolved_by: body.by || 'Manager', resolved_at: new Date().toISOString() }),
      });
      return json(200, { ok: true });
    }

    // ---------------------------------------------------------------- admin
    if (action === 'admin_load') {
      needManager();
      const [routines, tasks, units, wasteItems, staff] = await Promise.all([
        db('routines?select=*&order=sort'),
        db('tasks?select=*&order=sort'),
        db('units?select=*&order=kind,sort'),
        db('waste_items?select=*&order=sort'),
        db('staff?select=*&order=sort,name'),
      ]);
      return json(200, { routines, tasks, units, wasteItems, staff });
    }

    if (action === 'save_row') {
      needManager();
      const allowed = ['tasks', 'routines', 'units', 'waste_items', 'staff'];
      if (!allowed.includes(body.table)) return json(400, { error: 'Unknown table.' });
      const row = body.row || {};
      if (row.id) {
        const id = row.id; delete row.id;
        const r = await db(body.table + '?id=eq.' + id, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
        return json(200, { row: r[0] });
      }
      const r = await db(body.table, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
      return json(200, { row: r[0] });
    }

    if (action === 'delete_row') {
      needManager();
      const allowed = ['tasks', 'units', 'waste_items', 'staff'];
      if (!allowed.includes(body.table)) return json(400, { error: 'Unknown table.' });
      await db(body.table + '?id=eq.' + body.id, { method: 'PATCH', body: JSON.stringify({ active: false }) });
      return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown action: ' + action });
  } catch (e) {
    return json(500, { error: String(e.message || e).slice(0, 400) });
  }
};
