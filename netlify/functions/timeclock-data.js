// Time Clock data API. All reads/writes go through here with the Apps service-role
// key (RLS bypassed) so selfies, GPS and staff PII never touch the browser directly.
// Gated by portal auth + 'timeclock' app access; supervisor actions are role-checked.

const { json, validatePortalUser } = require('./_portal');

const APPS_URL   = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY   = process.env.APPS_SERVICE_ROLE_KEY;
const PORTAL_URL = 'https://zpcbtfdjcsbdeqnizrpr.supabase.co';
const PORTAL_KEY = process.env.PORTAL_SERVICE_ROLE_KEY;

async function db(path, opts = {}) {
  const headers = {
    apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'timeclock', 'Content-Profile': 'timeclock', ...(opts.headers || {}),
  };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 200));
  return data;
}

async function isSupervisor(userId) {
  const p = await fetch(PORTAL_URL + '/rest/v1/profiles?id=eq.' + userId + '&select=is_admin', {
    headers: { apikey: PORTAL_KEY, Authorization: 'Bearer ' + PORTAL_KEY },
  }).then(r => r.json()).catch(() => []);
  if (p && p[0] && p[0].is_admin) return true;
  const a = await fetch(PORTAL_URL + '/rest/v1/user_app_access?user_id=eq.' + userId + '&app_id=eq.timeclock&select=role', {
    headers: { apikey: PORTAL_KEY, Authorization: 'Bearer ' + PORTAL_KEY },
  }).then(r => r.json()).catch(() => []);
  return !!(a && a[0] && a[0].role === 'supervisor');
}

// NZ calendar date (YYYY-MM-DD) for an instant.
function nzDate(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(iso ? new Date(iso) : new Date());
}
// NZ hour (0-23) right now.
function nzHourNow() {
  return Number(new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', hour: '2-digit', hour12: false }).format(new Date()));
}
function haversine(aLat, aLng, bLat, bLng) {
  const R = 6371000, toR = d => d * Math.PI / 180;
  const dLat = toR(bLat - aLat), dLng = toR(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}
// Derive current clock state from a staff member's latest punch.
function stateFrom(lastType) {
  if (!lastType || lastType === 'out') return 'out';
  if (lastType === 'in' || lastType === 'break_end') return 'in';
  if (lastType === 'break_start') return 'on_break';
  return 'out';
}
function allowedNext(state) {
  if (state === 'out') return ['in'];
  if (state === 'in') return ['break_start', 'out', 'switch'];
  if (state === 'on_break') return ['break_end', 'out'];
  return [];
}

async function settingsObj() {
  const rows = await db('setting?select=key,value');
  const o = {}; (rows || []).forEach(r => { o[r.key] = r.value; });
  return o;
}
async function lastPunch(staffId) {
  const r = await db('punch?staff_id=eq.' + staffId + '&select=id,type,area_id,punched_at&order=punched_at.desc&limit=1');
  return (r && r[0]) || null;
}
async function staffByEmail(email) {
  if (!email) return null;
  const r = await db('staff?email=ilike.' + encodeURIComponent(email) + '&active=eq.true&select=*&limit=1');
  return (r && r[0]) || null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!APPS_KEY || !PORTAL_KEY) return json(500, { error: 'Server not configured.' });

  const auth = await validatePortalUser(event, 'timeclock');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  const action = body.action;
  const email = auth.user.email;

  try {
    const sup = await isSupervisor(auth.user.id);
    const me = await staffByEmail(email);

    if (action === 'bootstrap') {
      const [areas, settings] = await Promise.all([
        db('area?active=eq.true&select=id,job_number,label,metric_code,sort&order=sort'),
        settingsObj(),
      ]);
      let myState = 'out', myLast = null;
      if (me) { myLast = await lastPunch(me.id); myState = stateFrom(myLast && myLast.type); }
      const staff = sup ? await db('staff?active=eq.true&select=id,name,email&order=name') : [];
      return json(200, {
        me: me ? { id: me.id, name: me.name, email: me.email } : null,
        is_supervisor: sup, areas, settings,
        my_state: myState, my_last: myLast, staff,
        server_now: new Date().toISOString(),
      });
    }

    if (action === 'punch') {
      // Resolve which staff member this punch is for.
      let target = me;
      if (body.staff_id && sup) {
        const r = await db('staff?id=eq.' + Number(body.staff_id) + '&select=*&limit=1');
        target = (r && r[0]) || null;
      }
      if (!target) return json(403, { error: 'You are not set up as a clock-in staff member yet. Ask a supervisor.' });

      const type = body.type;
      if (!['in', 'break_start', 'break_end', 'out', 'switch'].includes(type)) return json(400, { error: 'Unknown punch type.' });

      const last = await lastPunch(target.id);
      const state = stateFrom(last && last.type);
      if (!allowedNext(state).includes(type)) {
        const nice = { out: 'clocked out', in: 'clocked in', on_break: 'on a break' };
        return json(409, { error: 'You are currently ' + (nice[state] || state) + ' — that action is not available.' });
      }
      if ((type === 'in' || type === 'switch') && !body.area_id) return json(400, { error: 'Pick an area.' });

      // Job switch within 1 minute of the last area change = a mistake correction:
      // ignore the short segment rather than littering the timesheet.
      if (type === 'switch') {
        const newArea = Number(body.area_id);
        const recentAreas = await db('punch?staff_id=eq.' + target.id + '&type=in.(in,switch)&select=id,type,area_id,punched_at&order=punched_at.desc&limit=2');
        const lastA = recentAreas && recentAreas[0];
        const prevA = recentAreas && recentAreas[1];
        if (lastA && (Date.now() - new Date(lastA.punched_at).getTime()) < 60000) {
          if (lastA.area_id === newArea) {
            return json(200, { ok: true, state: 'in', corrected: true, punch: { id: lastA.id, type: lastA.type, punched_at: lastA.punched_at, distance_m: null, in_range: null } });
          }
          if (lastA.type === 'in') {
            await db('punch?id=eq.' + lastA.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ area_id: newArea, note: 'area corrected within 1 min' }) });
            return json(200, { ok: true, state: 'in', corrected: true, punch: { id: lastA.id, type: 'in', punched_at: lastA.punched_at, distance_m: null, in_range: null } });
          }
          // last was a short switch -> delete it (ignore the short segment)
          await db('punch?id=eq.' + lastA.id, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
          if (prevA && prevA.area_id === newArea) {
            return json(200, { ok: true, state: 'in', corrected: true, punch: { id: prevA.id, type: prevA.type, punched_at: prevA.punched_at, distance_m: null, in_range: null } });
          }
          // else fall through and insert a fresh switch to newArea
        }
      }

      // Geofence
      const s = await settingsObj();
      let distance = null, inRange = null;
      const glat = parseFloat(s.geofence_lat), glng = parseFloat(s.geofence_lng), rad = parseFloat(s.geofence_radius_m) || 150;
      if (body.lat != null && body.lng != null && !isNaN(glat) && !isNaN(glng)) {
        distance = haversine(glat, glng, Number(body.lat), Number(body.lng));
        inRange = distance <= rad;
      }

      const row = {
        staff_id: target.id,
        type,
        area_id: (type === 'in' || type === 'switch') ? Number(body.area_id) : null,
        device_time: body.device_time || null,
        lat: body.lat != null ? Number(body.lat) : null,
        lng: body.lng != null ? Number(body.lng) : null,
        accuracy_m: body.accuracy != null ? Number(body.accuracy) : null,
        distance_m: distance,
        in_range: inRange,
        source: (body.staff_id && sup && target.id !== (me && me.id)) ? 'supervisor' : (body.source || 'phone'),
        selfie: body.selfie || null,
        created_by: email,
      };
      const ins = await db('punch', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
      const newLast = ins && ins[0];
      return json(200, { ok: true, state: stateFrom(newLast.type), punch: { id: newLast.id, type: newLast.type, punched_at: newLast.punched_at, distance_m: distance, in_range: inRange } });
    }

    if (action === 'actor_state') {
      if (!sup) return json(403, { error: 'Supervisor access required.' });
      const sid = Number(body.staff_id);
      if (!sid) return json(400, { error: 'staff_id required.' });
      const today = nzDate();
      const ps = await db('punch?staff_id=eq.' + sid + '&select=id,type,area_id,punched_at,distance_m,in_range&order=punched_at.asc');
      const todayPs = (ps || []).filter(p => nzDate(p.punched_at) === today);
      return json(200, { punches: todayPs, state: stateFrom(todayPs.length ? todayPs[todayPs.length - 1].type : null) });
    }

    if (action === 'my_timesheet') {
      if (!me) return json(200, { punches: [], requests: [], me: null });
      const days = Math.min(Math.max(parseInt(body.days || 14, 10) || 14, 1), 62);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const [punches, reqs] = await Promise.all([
        db('punch?staff_id=eq.' + me.id + '&punched_at=gte.' + since + '&select=id,type,area_id,punched_at,device_time,distance_m,in_range,source&order=punched_at.asc'),
        db('change_request?staff_id=eq.' + me.id + '&select=*&order=created_at.desc'),
      ]);
      return json(200, { punches, requests: reqs, me: { id: me.id, name: me.name } });
    }

    if (action === 'submit_change') {
      if (!me) return json(403, { error: 'You are not set up as a clock-in staff member yet.' });
      const row = {
        staff_id: me.id,
        punch_id: body.punch_id || null,
        kind: body.kind || 'edit_time',
        field: body.field || null,
        original_value: body.original_value != null ? String(body.original_value) : null,
        requested_value: body.requested_value != null ? String(body.requested_value) : null,
        reason: body.reason || null,
        requested_by: email,
      };
      if (!row.reason) return json(400, { error: 'Please add a reason for the change.' });
      await db('change_request', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
      return json(200, { ok: true });
    }

    if (action === 'whos_on') {
      // Everyone currently clocked in (in or on_break), with area + since.
      const staff = await db('staff?active=eq.true&select=id,name');
      const areas = await db('area?select=id,label');
      const areaMap = {}; areas.forEach(a => { areaMap[a.id] = a.label; });
      const out = [];
      for (const st of staff) {
        const lp = await db('punch?staff_id=eq.' + st.id + '&select=type,area_id,punched_at&order=punched_at.desc&limit=1');
        const p = lp && lp[0];
        const state = stateFrom(p && p.type);
        if (state === 'in' || state === 'on_break') {
          // area = most recent area-bearing punch (in OR switch); since = most recent 'in'
          const areaP = await db('punch?staff_id=eq.' + st.id + '&type=in.(in,switch)&select=area_id&order=punched_at.desc&limit=1');
          const sinceP = await db('punch?staff_id=eq.' + st.id + '&type=eq.in&select=punched_at&order=punched_at.desc&limit=1');
          const areaId = areaP && areaP[0] && areaP[0].area_id;
          const sinceIn = sinceP && sinceP[0] && sinceP[0].punched_at;
          out.push({ staff_id: st.id, name: st.name, state, area: areaMap[areaId] || '—', since: sinceIn });
        }
      }
      out.sort((a, b) => (a.area || '').localeCompare(b.area || '') || (a.name || '').localeCompare(b.name || ''));
      return json(200, { on: out });
    }

    // ================= SUPERVISOR =================
    if (action === 'supervisor_feed') {
      if (!sup) return json(403, { error: 'Supervisor access required.' });
      const day = body.date || nzDate();
      const dayStartUTC = new Date(day + 'T00:00:00+13:00'); // NZ; DST handled loosely, fine for a day window
      const from = new Date(dayStartUTC.getTime() - 2 * 3600000).toISOString();
      const to = new Date(dayStartUTC.getTime() + 26 * 3600000).toISOString();
      const [staff, areas, punchesRaw, pending] = await Promise.all([
        db('staff?active=eq.true&select=id,name'),
        db('area?select=id,label'),
        db('punch?punched_at=gte.' + from + '&punched_at=lte.' + to + '&select=id,staff_id,type,area_id,punched_at,distance_m,in_range,source&order=punched_at.asc'),
        db('change_request?status=eq.pending&select=*&order=created_at.asc'),
      ]);
      const sMap = {}; staff.forEach(s => { sMap[s.id] = s.name; });
      const aMap = {}; areas.forEach(a => { aMap[a.id] = a.label; });
      const punches = (punchesRaw || []).filter(p => nzDate(p.punched_at) === day).map(p => ({
        ...p, staff_name: sMap[p.staff_id] || '—', area: aMap[p.area_id] || null,
      }));
      // Open shifts right now (across all staff) + 6pm warning
      const warnHour = parseInt((await settingsObj()).open_shift_warn_hour || '18', 10);
      const nowHour = nzHourNow();
      const open = [];
      for (const st of staff) {
        const lp = await db('punch?staff_id=eq.' + st.id + '&select=type,punched_at&order=punched_at.desc&limit=1');
        const p = lp && lp[0]; const state = stateFrom(p && p.type);
        if (state === 'in' || state === 'on_break') {
          open.push({ staff_id: st.id, name: sMap[st.id], state, since: p.punched_at, warn: nowHour >= warnHour });
        }
      }
      const exceptions = {
        out_of_range: punches.filter(p => p.in_range === false),
        no_location: punches.filter(p => p.distance_m == null && (p.type === 'in' || p.type === 'out')),
        open_past_warn: open.filter(o => o.warn),
      };
      const pend = (pending || []).map(r => ({ ...r, staff_name: sMap[r.staff_id] || '—' }));
      return json(200, { date: day, punches, open, exceptions, pending: pend, warn_hour: warnHour });
    }

    if (action === 'get_selfie') {
      if (!sup) return json(403, { error: 'Supervisor access required.' });
      const r = await db('punch?id=eq.' + Number(body.punch_id) + '&select=selfie,punched_at,type&limit=1');
      return json(200, { selfie: (r && r[0] && r[0].selfie) || null });
    }

    if (action === 'resolve_change') {
      if (!sup) return json(403, { error: 'Supervisor access required.' });
      const id = Number(body.id);
      const decision = body.decision; // 'approve' | 'reject'
      if (!['approve', 'reject'].includes(decision)) return json(400, { error: 'Bad decision.' });
      const cr = (await db('change_request?id=eq.' + id + '&select=*&limit=1'))[0];
      if (!cr) return json(404, { error: 'Request not found.' });
      if (cr.status !== 'pending') return json(409, { error: 'Already resolved.' });

      if (decision === 'approve') {
        if (cr.kind === 'edit_time' && cr.punch_id && cr.field === 'punched_at' && cr.requested_value) {
          await db('punch?id=eq.' + cr.punch_id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ punched_at: cr.requested_value, note: 'edited via change request #' + id }) });
        } else if (cr.kind === 'add_punch' && cr.requested_value) {
          let add; try { add = JSON.parse(cr.requested_value); } catch { add = null; }
          if (add && add.type && add.punched_at) {
            await db('punch', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
              staff_id: cr.staff_id, type: add.type, area_id: add.area_id || null, punched_at: add.punched_at,
              source: 'supervisor', created_by: email, note: 'added via change request #' + id,
            }) });
          }
        }
      }
      await db('change_request?id=eq.' + id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
        status: decision === 'approve' ? 'approved' : 'rejected', resolved_by: email, resolved_at: new Date().toISOString(),
      }) });
      return json(200, { ok: true });
    }

    if (action === 'save_setting') {
      if (!sup) return json(403, { error: 'Supervisor access required.' });
      const { key, value } = body;
      const allowed = ['cafe_address', 'geofence_lat', 'geofence_lng', 'geofence_radius_m', 'open_shift_warn_hour', 'unpaid_break_min', 'selfie_retention_days'];
      if (!allowed.includes(key)) return json(400, { error: 'Unknown setting.' });
      const patched = await db('setting?key=eq.' + encodeURIComponent(key), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ value: String(value) }) });
      if (!Array.isArray(patched) || !patched.length) {
        await db('setting', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ key, value: String(value) }) });
      }
      return json(200, { ok: true });
    }

    if (action === 'leave_overview') {
      // Skeleton only — structure returns empty until leave is switched on.
      if (!me && !sup) return json(200, { enabled: false, balances: [], requests: [] });
      const staffId = (body.staff_id && sup) ? Number(body.staff_id) : (me && me.id);
      const balances = staffId ? await db('leave_balance?staff_id=eq.' + staffId + '&select=*') : [];
      const requests = staffId ? await db('leave_request?staff_id=eq.' + staffId + '&select=*&order=created_at.desc') : [];
      return json(200, { enabled: false, balances, requests });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (e) {
    return json(502, { error: String(e.message || e).slice(0, 200) });
  }
};
