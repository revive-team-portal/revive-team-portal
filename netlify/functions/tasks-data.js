// Data API for the Revive Tasks app.
//
// Structure: SHEET -> BOARD -> TASK.
//   sheet  – a workspace people are granted access to (Jeremy Cafe, Cafe Shared, …)
//   board  – a coloured tile inside a sheet (General, Projects, …)
//   task   – sits on a board, in one of three bands: current / future / park
//
// Everyone with access to a sheet sees and can edit everything in it. A manager
// (portal admin, or user_app_access.role='manager') sees every sheet and runs Admin.
//
// The `tasks` schema has RLS on with ZERO policies for `authenticated`, so the browser
// reads nothing directly — every read and write comes through here on the service key.

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

// --------------------------------------------------------------------------- dates
function nzToday() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' }); }
function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// --------------------------------------------------------------------------- who
async function accessLevel(userId, profile) {
  if (profile && profile.is_admin) return 'manager';
  if (!profile) {
    const p = await portalRest('profiles?id=eq.' + userId + '&select=is_admin');
    if (p && p[0] && p[0].is_admin) return 'manager';
  }
  const a = await portalRest('user_app_access?user_id=eq.' + userId + '&app_id=eq.tasks&select=role');
  const role = a && a[0] ? (a[0].role || 'team') : null;
  if (role === 'manager') return 'manager';
  if (role) return 'team';
  return null;
}

// Keeps tasks.person in step with the portal, and grants any brand-new person the
// default sheets (Cafe Shared) exactly once — so revoking it later actually sticks.
async function syncPeople() {
  const [profiles, access, existing] = await Promise.all([
    portalRest('profiles?select=id,email,full_name,is_admin,active'),
    portalRest('user_app_access?app_id=eq.tasks&select=user_id,role'),
    db('person?select=id,access_seeded'),
  ]);
  if (!Array.isArray(profiles) || !profiles.length) return [];

  const roleBy = {};
  (Array.isArray(access) ? access : []).forEach(a => { roleBy[a.user_id] = a.role || 'team'; });
  const granted = profiles.filter(p => p.is_admin || roleBy[p.id]);
  if (!granted.length) return [];

  const seeded = new Set((existing || []).filter(p => p.access_seeded).map(p => p.id));

  await db('person?on_conflict=id', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(granted.map(p => ({
      id: p.id,
      full_name: p.full_name || (p.email || '').split('@')[0],
      email: p.email || null,
      is_manager: !!p.is_admin || roleBy[p.id] === 'manager',
      active: p.active !== false,
    }))),
  });

  const fresh = granted.filter(p => !seeded.has(p.id));
  if (fresh.length) {
    const defaults = await db('sheet?select=id&is_default=eq.true');
    if (defaults && defaults.length) {
      const rows = [];
      fresh.forEach(p => defaults.forEach(s => rows.push({ sheet_id: s.id, person_id: p.id })));
      await db('sheet_access?on_conflict=sheet_id,person_id', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows),
      });
    }
    await db('person?id=in.(' + fresh.map(p => p.id).join(',') + ')', {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ access_seeded: true }),
    });
  }

  return db('person?select=*&active=eq.true&order=is_manager.desc,full_name.asc');
}

// --------------------------------------------------------------------------- rollover
// Anything still sitting in Current from a previous week rolls forward and its carry
// counter ticks up — the visible "carried x3" that makes a stalled task obvious.
async function rollover(weekStart, stale) {
  if (!Array.isArray(stale) || !stale.length) return 0;
  const now = new Date().toISOString();
  const logUpsert = rows => db('week_log?on_conflict=task_id,week_start', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows),
  });
  await Promise.all([
    logUpsert(stale.map(t => ({ task_id: t.id, person_id: t.owner_id, week_start: t.committed_week, completed: false, closed_at: now }))),
    logUpsert(stale.map(t => ({ task_id: t.id, person_id: t.owner_id, week_start: weekStart }))),
    ...stale.map(t => db('task?id=eq.' + t.id, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ committed_week: weekStart, carry_count: (t.carry_count || 0) + 1, updated_at: now }),
    })),
  ]);
  return stale.length;
}

// ---------------------------------------------------------------------------
const TASK_FIELDS  = ['title', 'notes', 'owner_id', 'category_id', 'priority', 'horizon',
  'committed_week', 'due_date', 'done', 'sort_order'];
const BOARD_FIELDS = ['name', 'icon', 'colour', 'sheet_id', 'sort_order', 'archived'];

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

  const level = await accessLevel(auth.user.id, auth.profile);
  if (!level) return json(403, { error: 'You do not have access to Tasks.' });

  const me = auth.user.id;
  const isManager = level === 'manager';

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  const action = body.action;

  // Sheets the caller may touch. A manager may touch all of them.
  let _sheets = null;
  async function mySheetIds() {
    if (_sheets) return _sheets;
    if (isManager) {
      const all = await db('sheet?select=id');
      _sheets = new Set((all || []).map(s => s.id));
    } else {
      const mine = await db('sheet_access?select=sheet_id&person_id=eq.' + me);
      _sheets = new Set((mine || []).map(s => s.sheet_id));
    }
    return _sheets;
  }
  async function canUseBoard(boardId) {
    if (isManager) return true;
    if (!boardId) return false;
    const rows = await db('category?select=sheet_id&id=eq.' + boardId);
    return !!(rows && rows[0]) && (await mySheetIds()).has(rows[0].sheet_id);
  }
  async function canUseTask(taskId) {
    if (isManager) return true;
    const rows = await db('task?select=category_id,owner_id&id=eq.' + taskId);
    const t = rows && rows[0];
    if (!t) return false;
    if (t.owner_id === me) return true;
    return canUseBoard(t.category_id);
  }
  function requireManager() { return isManager ? null : json(403, { error: 'Manager access required.' }); }

  try {
    // ------------------------------------------------------------- bootstrap
    if (action === 'bootstrap') {
      const today = nzToday();
      const week  = mondayOf(today);

      const [people, sheets, myAccess, stale] = await Promise.all([
        syncPeople(),
        db('sheet?select=*&order=sort_order.asc,name.asc'),
        db('sheet_access?select=sheet_id,person_id'),
        db('task?select=id,carry_count,owner_id,committed_week&done=eq.false&horizon=eq.week&committed_week=lt.' + week),
      ]);
      const carried = await rollover(week, stale);

      const mineIds = isManager
        ? (sheets || []).map(s => s.id)
        : (myAccess || []).filter(a => a.person_id === me).map(a => a.sheet_id);
      const visibleSheets = (sheets || []).filter(s => mineIds.includes(s.id));

      if (!visibleSheets.length) {
        return json(200, { me, level, today, week, carried: 0, people, sheets: [], access: [], boards: [], tasks: [] });
      }

      const sheetIn = '(' + visibleSheets.map(s => s.id).join(',') + ')';
      const boards = await db('category?select=*&archived=eq.false&sheet_id=in.' + sheetIn + '&order=sort_order.asc,name.asc');
      const boardIds = (boards || []).map(b => b.id);

      let tasks = [];
      if (boardIds.length) {
        const inB = '(' + boardIds.join(',') + ')';
        const cutoff = addDays(today, -60);
        const [open, done] = await Promise.all([
          db('task?select=*&done=eq.false&category_id=in.' + inB + '&order=sort_order.asc,created_at.asc'),
          db('task?select=*&done=eq.true&done_at=gte.' + cutoff + 'T00:00:00Z&category_id=in.' + inB + '&order=done_at.desc'),
        ]);
        tasks = [].concat(open || [], done || []);
      }

      return json(200, {
        me, level, today, week, carried,
        people, sheets: visibleSheets, allSheets: isManager ? (sheets || []) : [],
        access: isManager ? (myAccess || []) : [], boards: boards || [], tasks,
      });
    }

    // ------------------------------------------------------------- tasks
    if (action === 'save_task') {
      const row = pick(body.task || {}, TASK_FIELDS);
      if (!body.id || 'title' in row) {
        if (!row.title || !String(row.title).trim()) return json(400, { error: 'A task needs a title.' });
        row.title = String(row.title).slice(0, 500);
      }
      row.updated_at = new Date().toISOString();

      if (body.id) {
        if (!(await canUseTask(body.id))) return json(403, { error: 'That task is on a sheet you cannot access.' });
        const out = await db('task?id=eq.' + body.id, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
        return json(200, { task: out && out[0] });
      }
      if (!(await canUseBoard(row.category_id))) return json(403, { error: 'That board is on a sheet you cannot access.' });
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
      if (!(await canUseTask(body.id))) return json(403, { error: 'That task is on a sheet you cannot access.' });
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
      if (!(await canUseTask(body.id))) return json(403, { error: 'That task is on a sheet you cannot access.' });
      await db('task?id=eq.' + body.id, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return json(200, { ok: true });
    }

    // Bulk move after a drag: board and/or band.
    if (action === 'move_tasks') {
      const items = Array.isArray(body.items) ? body.items.slice(0, 300) : [];
      for (const it of items) {
        if (!(await canUseTask(it.id))) continue;
        if ('category_id' in it && !(await canUseBoard(it.category_id))) continue;
        const patch = { updated_at: new Date().toISOString() };
        ['category_id', 'horizon', 'committed_week', 'sort_order', 'priority'].forEach(k => {
          if (k in it) patch[k] = it[k];
        });
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

    // ------------------------------------------------------------- boards
    if (action === 'save_board') {
      const row = pick(body.board || {}, BOARD_FIELDS);
      if (!body.id || 'name' in row) {
        if (!row.name || !String(row.name).trim()) return json(400, { error: 'A board needs a name.' });
        row.name = String(row.name).slice(0, 80);
      }
      if (body.id) {
        if (!(await canUseBoard(body.id))) return json(403, { error: 'That board is on a sheet you cannot access.' });
        const out = await db('category?id=eq.' + body.id, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
        return json(200, { board: out && out[0] });
      }
      if (!row.sheet_id || !(await mySheetIds()).has(row.sheet_id)) return json(403, { error: 'Pick a sheet you have access to.' });
      const out = await db('category', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
      return json(200, { board: out && out[0] });
    }

    if (action === 'delete_board') {
      if (!(await canUseBoard(body.id))) return json(403, { error: 'That board is on a sheet you cannot access.' });
      // Move the tasks to another board on the same sheet so nothing goes invisible.
      const rows = await db('category?select=sheet_id&id=eq.' + body.id);
      const sid = rows && rows[0] ? rows[0].sheet_id : null;
      if (sid) {
        const sibs = await db('category?select=id&archived=eq.false&limit=1&order=sort_order.asc&sheet_id=eq.' + sid + '&id=neq.' + body.id);
        if (sibs && sibs[0]) {
          await db('task?category_id=eq.' + body.id, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ category_id: sibs[0].id }),
          });
        } else {
          return json(400, { error: 'This is the only board on the sheet — add another before deleting this one.' });
        }
      }
      await db('category?id=eq.' + body.id, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return json(200, { ok: true });
    }

    // ------------------------------------------------------------- sheets (admin)
    if (action === 'save_sheet') {
      const deny = requireManager(); if (deny) return deny;
      const name = String((body.sheet || {}).name || '').trim();
      if (!name) return json(400, { error: 'A sheet needs a name.' });
      const row = { name: name.slice(0, 80), is_default: !!(body.sheet || {}).is_default };
      if ('sort_order' in (body.sheet || {})) row.sort_order = body.sheet.sort_order;

      let saved;
      if (body.id) {
        const out = await db('sheet?id=eq.' + body.id, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
        saved = out && out[0];
      } else {
        const out = await db('sheet', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
        saved = out && out[0];
        // A brand-new sheet starts with two placeholder boards so it is never blank.
        if (saved) {
          await db('category', {
            method: 'POST', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify([
              { sheet_id: saved.id, name: 'General',  icon: '📋', colour: 'sky',    sort_order: 10 },
              { sheet_id: saved.id, name: 'Projects', icon: '🚀', colour: 'violet', sort_order: 20 },
            ]),
          });
        }
      }

      if (saved && Array.isArray(body.access)) {
        const ids = [...new Set(body.access.filter(Boolean))];
        await db('sheet_access?sheet_id=eq.' + saved.id, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
        if (ids.length) {
          await db('sheet_access', {
            method: 'POST', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify(ids.map(pid => ({ sheet_id: saved.id, person_id: pid }))),
          });
        }
      }
      return json(200, { sheet: saved });
    }

    if (action === 'delete_sheet') {
      const deny = requireManager(); if (deny) return deny;
      // Boards cascade with the sheet, but tasks would be left orphaned (the FK only
      // nulls their board), so clear them out first.
      const bs = await db('category?select=id&sheet_id=eq.' + body.id);
      if (bs && bs.length) {
        await db('task?category_id=in.(' + bs.map(b => b.id).join(',') + ')', { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      }
      await db('sheet?id=eq.' + body.id, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (e) {
    return json(500, { error: e.message || 'Something went wrong.' });
  }
};
