// Data API for the Revive Tasks app.
//
// The `tasks` schema has RLS enabled with ZERO policies for `authenticated`, so the
// browser can read nothing directly — every read and write goes through here, gated
// on a portal user plus an access level, using the apps-project service-role key.
//
// Access levels:
//   manager – portal admin, or user_app_access.role='manager' → sees and edits everyone
//   team    – any other granted user                          → own tasks + shared categories

const { json, validatePortalUser } = require('./_portal');

const APPS_URL   = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY   = process.env.APPS_SERVICE_ROLE_KEY;
const PORTAL_URL = 'https://zpcbtfdjcsbdeqnizrpr.supabase.co';
const PORTAL_KEY = process.env.PORTAL_SERVICE_ROLE_KEY;

async function db(path, opts = {}) {
  const headers = {
    apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'tasks', 'Content-Profile': 'tasks', ...(opts.headers || {}),
  };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 300));
  return data;
}

function portalRest(path) {
  return fetch(PORTAL_URL + '/rest/v1/' + path, {
    headers: { apikey: PORTAL_KEY, Authorization: 'Bearer ' + PORTAL_KEY },
  }).then(r => r.json()).catch(() => []);
}

// ---------------------------------------------------------------------------
// Week helpers. Weeks run Monday → Sunday, in NZ local time.
// ---------------------------------------------------------------------------
function nzToday() {
  // en-CA gives YYYY-MM-DD
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
}
function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const dow = d.getUTCDay();                 // 0=Sun … 6=Sat
  const back = dow === 0 ? 6 : dow - 1;      // Monday-based
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function quarterOf(iso) {
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7));
  return y + '-Q' + Math.ceil(m / 3);
}

// ---------------------------------------------------------------------------
// Who is calling
// ---------------------------------------------------------------------------
async function accessLevel(userId) {
  const p = await portalRest('profiles?id=eq.' + userId + '&select=is_admin');
  if (p && p[0] && p[0].is_admin) return 'manager';
  const a = await portalRest('user_app_access?user_id=eq.' + userId + '&app_id=eq.tasks&select=role');
  const role = a && a[0] ? (a[0].role || 'team') : null;
  if (role === 'manager') return 'manager';
  if (role) return 'team';
  return null;
}

// Keep tasks.person in step with the portal automatically, so nobody has to
// maintain a second user list. Runs on every bootstrap; cheap at this team size.
async function syncPeople() {
  const [profiles, access] = await Promise.all([
    portalRest('profiles?select=id,email,full_name,is_admin,active'),
    portalRest('user_app_access?app_id=eq.tasks&select=user_id,role'),
  ]);
  if (!Array.isArray(profiles) || !profiles.length) return [];
  const roleBy = {};
  (Array.isArray(access) ? access : []).forEach(a => { roleBy[a.user_id] = a.role || 'team'; });

  const granted = profiles.filter(p => p.is_admin || roleBy[p.id]);
  if (granted.length) {
    const rows = granted.map(p => ({
      id: p.id,
      full_name: p.full_name || (p.email || '').split('@')[0],
      email: p.email || null,
      is_manager: !!p.is_admin || roleBy[p.id] === 'manager',
      active: p.active !== false,
    }));
    await db('person?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
  }
  return db('person?select=*&active=eq.true&order=is_manager.desc,full_name.asc');
}

// Categories belong to one person, so a new user starts with their own copy of a
// sensible default set rather than an empty screen. Runs once — the moment they
// own at least one board (even after deleting the rest) it never fires again.
const DEFAULT_BOARDS = [
  { name: 'Cafe',              icon: '☕',  colour: 'amber',   sort_order: 10 },
  { name: 'Wholesale & Sales', icon: '📊', colour: 'sky',     sort_order: 20 },
  { name: 'Marketing',         icon: '📣', colour: 'rose',    sort_order: 30 },
  { name: 'Production',        icon: '🧇', colour: 'green',   sort_order: 40 },
  { name: 'People & Team',     icon: '👥', colour: 'violet',  sort_order: 50 },
  { name: 'Finance & Admin',   icon: '💰', colour: 'emerald', sort_order: 60 },
  { name: 'Systems & IT',      icon: '⚙️', colour: 'slate',   sort_order: 70 },
];
async function seedBoards(userId) {
  const existing = await db('category?select=id&limit=1&owner_id=eq.' + userId);
  if (Array.isArray(existing) && existing.length) return false;
  await db('category', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(DEFAULT_BOARDS.map(b => ({ ...b, owner_id: userId, shared: false }))),
  });
  return true;
}

// ---------------------------------------------------------------------------
// Weekly rollover. Any task still committed to a week before this one, and not
// done, rolls forward and its carry counter ticks up — that visible number is
// the accountability signal in the 1:1.
// ---------------------------------------------------------------------------
async function rollover(weekStart) {
  const stale = await db('task?select=id,carry_count,owner_id,committed_week&done=eq.false&horizon=eq.week&committed_week=lt.' + weekStart);
  if (!Array.isArray(stale) || !stale.length) return 0;

  // Close out last week's log rows as not completed.
  await db('week_log?on_conflict=task_id,week_start', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(stale.map(t => ({
      task_id: t.id, person_id: t.owner_id, week_start: t.committed_week,
      completed: false, closed_at: new Date().toISOString(),
    }))),
  });

  for (const t of stale) {
    await db('task?id=eq.' + t.id, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        committed_week: weekStart,
        carry_count: (t.carry_count || 0) + 1,
        updated_at: new Date().toISOString(),
      }),
    });
  }
  // Open this week's log rows for the carried tasks.
  await db('week_log?on_conflict=task_id,week_start', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(stale.map(t => ({ task_id: t.id, person_id: t.owner_id, week_start: weekStart }))),
  });
  return stale.length;
}

// ---------------------------------------------------------------------------
const TASK_FIELDS = ['title', 'notes', 'owner_id', 'category_id', 'goal_id', 'priority',
  'horizon', 'committed_week', 'due_date', 'done', 'sort_order', 'is_gm_action', 'for_person_id'];
const GOAL_FIELDS = ['title', 'detail', 'owner_id', 'quarter', 'due_date', 'status', 'progress', 'sort_order'];
const CAT_FIELDS  = ['name', 'icon', 'colour', 'owner_id', 'shared', 'sort_order', 'archived'];

function pick(src, fields) {
  const out = {};
  fields.forEach(f => { if (Object.prototype.hasOwnProperty.call(src, f)) out[f] = src[f]; });
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!APPS_KEY || !PORTAL_KEY) return json(500, { error: 'Server not configured.' });

  const auth = await validatePortalUser(event, 'tasks');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });

  const level = await accessLevel(auth.user.id);
  if (!level) return json(403, { error: 'You do not have access to Tasks.' });

  const me = auth.user.id;
  const isManager = level === 'manager';

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  const action = body.action;

  // A non-manager may only ever touch their own rows.
  const ownGuard = async (table, id) => {
    if (isManager) return true;
    const rows = await db(table + '?select=owner_id,for_person_id&id=eq.' + id);
    const r = rows && rows[0];
    return !!r && (r.owner_id === me || r.for_person_id === me);
  };

  try {
    // ---------------------------------------------------------------- bootstrap
    if (action === 'bootstrap') {
      const today = nzToday();
      const week = mondayOf(today);
      const people = await syncPeople();
      const carried = await rollover(week);

      // Every board belongs to one person. A non-manager sees their own boards plus
      // anything anyone has ticked as shared.
      await seedBoards(me);
      const catFilter = isManager ? '' : '&or=(owner_id.eq.' + me + ',shared.is.true)';
      const categories = await db('category?select=*&archived=eq.false' + catFilter + '&order=sort_order.asc,name.asc');

      // A board ticked as shared shows everyone's tasks; a private board shows only
      // its owner's work (and, to a manager, everything).
      const openBoards = (categories || []).filter(c => c.shared).map(c => c.id);
      let taskFilter = '';
      if (!isManager) {
        const clauses = ['owner_id.eq.' + me, 'for_person_id.eq.' + me];
        if (openBoards.length) clauses.push('category_id.in.(' + openBoards.join(',') + ')');
        taskFilter = '&or=(' + clauses.join(',') + ')';
      }
      const goalFilter = isManager ? '' : '&owner_id=eq.' + me;

      // Done tasks older than 60 days stay in the database but out of the payload.
      const cutoff = addDays(today, -60);

      const [tasksOpen, tasksDone, goals, checkins, logs] = await Promise.all([
        db('task?select=*&done=eq.false' + taskFilter + '&order=sort_order.asc,created_at.asc'),
        db('task?select=*&done=eq.true&done_at=gte.' + cutoff + 'T00:00:00Z' + taskFilter + '&order=done_at.desc'),
        db('goal?select=*' + goalFilter + '&order=sort_order.asc,created_at.asc'),
        db('checkin?select=*&week_start=gte.' + addDays(week, -56) + (isManager ? '' : '&person_id=eq.' + me)),
        db('week_log?select=*&week_start=gte.' + addDays(week, -56) + (isManager ? '' : '&person_id=eq.' + me)),
      ]);

      return json(200, {
        me, level, today, week, quarter: quarterOf(today), carried,
        people, categories, goals, checkins, logs,
        tasks: [].concat(tasksOpen || [], tasksDone || []),
      });
    }

    // ---------------------------------------------------------------- tasks
    if (action === 'save_task') {
      const row = pick(body.task || {}, TASK_FIELDS);
      if (!isManager) { row.owner_id = me; delete row.is_gm_action; delete row.for_person_id; }
      if (!body.id || 'title' in row) {
        if (!row.title || !String(row.title).trim()) return json(400, { error: 'A task needs a title.' });
        row.title = String(row.title).slice(0, 500);
      }
      row.updated_at = new Date().toISOString();

      if (body.id) {
        if (!(await ownGuard('task', body.id))) return json(403, { error: 'Not your task.' });
        const out = await db('task?id=eq.' + body.id, {
          method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row),
        });
        return json(200, { task: out && out[0] });
      }
      row.created_by = me;
      if (!row.owner_id) row.owner_id = me;
      const out = await db('task', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
      const t = out && out[0];
      if (t && t.horizon === 'week' && t.committed_week) {
        await db('week_log?on_conflict=task_id,week_start', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ task_id: t.id, person_id: t.owner_id, week_start: t.committed_week }),
        });
      }
      return json(200, { task: t });
    }

    if (action === 'toggle_task') {
      if (!(await ownGuard('task', body.id))) return json(403, { error: 'Not your task.' });
      const done = !!body.done;
      const out = await db('task?id=eq.' + body.id, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ done, done_at: done ? new Date().toISOString() : null, updated_at: new Date().toISOString() }),
      });
      const t = out && out[0];
      if (t && t.committed_week) {
        await db('week_log?on_conflict=task_id,week_start', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({
            task_id: t.id, person_id: t.owner_id, week_start: t.committed_week,
            completed: done, closed_at: done ? new Date().toISOString() : null,
          }),
        });
      }
      return json(200, { task: t });
    }

    if (action === 'delete_task') {
      if (!(await ownGuard('task', body.id))) return json(403, { error: 'Not your task.' });
      await db('task?id=eq.' + body.id, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return json(200, { ok: true });
    }

    // Bulk reorder / re-home after a drag.
    if (action === 'move_tasks') {
      const items = Array.isArray(body.items) ? body.items.slice(0, 300) : [];
      for (const it of items) {
        if (!(await ownGuard('task', it.id))) continue;
        const patch = { updated_at: new Date().toISOString() };
        if ('category_id' in it) patch.category_id = it.category_id;
        if ('horizon' in it) patch.horizon = it.horizon;
        if ('committed_week' in it) patch.committed_week = it.committed_week;
        if ('sort_order' in it) patch.sort_order = it.sort_order;
        if ('priority' in it) patch.priority = it.priority;
        await db('task?id=eq.' + it.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
        if (patch.horizon === 'week' && patch.committed_week) {
          const rows = await db('task?select=owner_id&id=eq.' + it.id);
          if (rows && rows[0]) {
            await db('week_log?on_conflict=task_id,week_start', {
              method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
              body: JSON.stringify({ task_id: it.id, person_id: rows[0].owner_id, week_start: patch.committed_week }),
            });
          }
        }
      }
      return json(200, { ok: true, moved: items.length });
    }

    // ---------------------------------------------------------------- categories
    if (action === 'save_category') {
      const row = pick(body.category || {}, CAT_FIELDS);
      if (!row.name || !String(row.name).trim()) return json(400, { error: 'A category needs a name.' });
      row.name = String(row.name).slice(0, 80);
      // Every board has exactly one owner. Only a manager may create one for someone else.
      if (!isManager || !row.owner_id) row.owner_id = isManager ? (row.owner_id || me) : me;
      if (body.id) {
        if (!isManager) {
          const rows = await db('category?select=owner_id&id=eq.' + body.id);
          if (!rows || !rows[0] || rows[0].owner_id !== me) return json(403, { error: "That board belongs to someone else." });
        }
        const out = await db('category?id=eq.' + body.id, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
        return json(200, { category: out && out[0] });
      }
      const out = await db('category', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
      return json(200, { category: out && out[0] });
    }

    if (action === 'delete_category') {
      if (!isManager) {
        const rows = await db('category?select=owner_id&id=eq.' + body.id);
        if (!rows || !rows[0] || rows[0].owner_id !== me) return json(403, { error: "That board belongs to someone else." });
      }
      // Tasks survive; they fall back to Uncategorised (category_id set null by FK).
      await db('category?id=eq.' + body.id, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return json(200, { ok: true });
    }

    if (action === 'reorder_categories') {
      const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
      for (const it of items) {
        await db('category?id=eq.' + it.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ sort_order: it.sort_order }) });
      }
      return json(200, { ok: true });
    }

    // ---------------------------------------------------------------- goals
    if (action === 'save_goal') {
      const row = pick(body.goal || {}, GOAL_FIELDS);
      if (!isManager && !body.id) row.owner_id = me;
      // Partial updates (status flip, progress slider) send only the changed field,
      // so only insist on a title when one was supplied or the goal is new.
      if (!body.id || 'title' in row) {
        if (!row.title || !String(row.title).trim()) return json(400, { error: 'A goal needs a title.' });
        row.title = String(row.title).slice(0, 300);
      }
      row.updated_at = new Date().toISOString();
      if (body.id) {
        if (!(await ownGuard('goal', body.id))) return json(403, { error: 'Not your goal.' });
        const out = await db('goal?id=eq.' + body.id, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
        return json(200, { goal: out && out[0] });
      }
      if (!row.owner_id) row.owner_id = me;
      if (!row.quarter) row.quarter = quarterOf(nzToday());
      const out = await db('goal', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
      return json(200, { goal: out && out[0] });
    }

    if (action === 'delete_goal') {
      if (!(await ownGuard('goal', body.id))) return json(403, { error: 'Not your goal.' });
      await db('goal?id=eq.' + body.id, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return json(200, { ok: true });
    }

    // ---------------------------------------------------------------- 1:1 notes
    if (action === 'save_checkin') {
      const person_id = isManager ? (body.person_id || me) : me;
      const out = await db('checkin?on_conflict=person_id,week_start', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          person_id, week_start: body.week_start || mondayOf(nzToday()),
          notes: String(body.notes || '').slice(0, 20000), updated_at: new Date().toISOString(),
        }),
      });
      return json(200, { checkin: out && out[0] });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (e) {
    return json(500, { error: e.message || 'Something went wrong.' });
  }
};
