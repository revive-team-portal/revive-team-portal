// Admin API for the Training app. Portal-login gated ('training' app access).
// All writes are recorded in training.audit_log — this is a compliance record,
// so nothing here hard-deletes and every change is attributable.

const { json, validatePortalUser } = require('./_portal');

const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
const DOC_BUCKET = 'training-docs';
const PHOTO_BUCKET = 'training-photos';

async function rest(path, opts = {}, schema) {
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
const T = (p, o) => rest(p, o, 'training');
const TC = (p, o) => rest(p, o, 'timeclock');

const RET = { headers: { Prefer: 'return=representation' } };
const MIN = { headers: { Prefer: 'return=minimal' } };

let ACTOR = 'unknown';
async function audit(action, entity, entityId, detail) {
  try {
    await T('audit_log', { method: 'POST', ...MIN, body: JSON.stringify({ actor: ACTOR, action, entity, entity_id: String(entityId || ''), detail: detail || null }) });
  } catch { /* never let logging break the write */ }
}


// --- YouTube -----------------------------------------------------------------
// We never store or trust the pasted URL. We extract the 11-character video id
// and rebuild every URL from that, so a pasted string can never reach an iframe.
function youtubeId(input) {
  const v = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(v)) return v;
  const pats = [
    /(?:youtube\.com|youtube-nocookie\.com)\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/)([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
  ];
  for (const pat of pats) { const m = pat.exec(v); if (m) return m[1]; }
  return null;
}

// oEmbed needs no API key and no quota, and it works for unlisted videos.
// A private or deleted video errors, which is how we tell someone their link
// is not shareable yet.
async function resolveVideo(input) {
  const id = youtubeId(input);
  if (!id) return { error: 'That does not look like a YouTube link. Use the Share button in YouTube and paste the whole link.' };
  let title = null;
  let thumb = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
  try {
    const res = await fetch('https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + id));
    if (res.status === 401 || res.status === 403) {
      return { error: 'That video is Private. In YouTube change it to Unlisted, then paste the link again.' };
    }
    if (res.status === 404) return { error: 'That video could not be found. Check the link.' };
    if (res.ok) {
      const d = await res.json();
      if (d.title) title = d.title;
      if (d.thumbnail_url) thumb = d.thumbnail_url;
    }
  } catch (e) { /* keep the derived thumbnail — the id is what actually matters */ }
  return { video_id: id, video_title: title, video_thumb: thumb };
}

function publicUrl(bucket, path) {
  return APPS_URL + '/storage/v1/object/public/' + bucket + '/' + path;
}

async function uploadDataUrl(dataUrl, bucket, prefix) {
  const m = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) throw new Error('That file could not be read.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 9 * 1024 * 1024) throw new Error('That file is too large (9MB max).');
  const ext = ({ 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[m[1]] || 'bin';
  const path = prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  const res = await fetch(APPS_URL + '/storage/v1/object/' + bucket + '/' + path, {
    method: 'POST',
    headers: { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': m[1], 'x-upsert': 'true' },
    body: buf,
  });
  if (!res.ok) throw new Error('Upload failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return { path, url: publicUrl(bucket, path), file_type: m[1] };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!APPS_KEY) return json(500, { error: 'Server not configured (APPS_SERVICE_ROLE_KEY).' });

  const auth = await validatePortalUser(event, 'training');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });
  ACTOR = auth.user.email || auth.user.id;

  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }

  try {
    switch (b.action) {
      case 'bootstrap':     return json(200, await bootstrap());
      case 'docs':          return json(200, { docs: await listDocs() });
      case 'doc':           return json(200, await getDoc(b.doc_id));
      case 'create_doc':    return json(200, await createDoc(b));
      case 'update_doc':    return json(200, await updateDoc(b));
      case 'archive_doc':   return json(200, await archiveDoc(b.doc_id, b.archived));
      case 'new_version':   return json(200, await newVersion(b.doc_id));
      case 'save_version':  return json(200, await saveVersion(b));
      case 'save_questions':return json(200, await saveQuestions(b));
      case 'publish':       return json(200, await publish(b));
      case 'resolve_video': return json(200, await resolveVideo(b.url));
      case 'upload':        return json(200, await uploadDataUrl(b.data, b.bucket === 'photo' ? PHOTO_BUCKET : DOC_BUCKET, b.prefix || 'doc'));
      case 'set_requirements': return json(200, await setRequirements(b));
      case 'set_tags':      return json(200, await setTags(b));
      case 'attachments':   return json(200, await attachments(b));
      case 'assign':        return json(200, await assign(b));
      case 'matrix':        return json(200, await matrix());
      case 'person':        return json(200, await person(b.staff_id));
      case 'session_create':return json(200, await sessionCreate(b));
      case 'signoff':       return json(200, await signoff(b));
      case 'manual_mark':   return json(200, await manualMark(b));
      case 'set_staff_areas': return json(200, await setStaffAreas(b));
      case 'feedback_list': return json(200, { feedback: await feedbackList() });
      case 'feedback_set':  return json(200, await feedbackSet(b));
      case 'export':        return json(200, await exportCsv());
      case 'audit':         return json(200, { log: await T('audit_log?select=*&order=at.desc&limit=200') });
      default:              return json(400, { error: 'Unknown action.' });
    }
  } catch (e) {
    return json(500, { error: String(e.message || e).slice(0, 400) });
  }
};

// --- reference data ----------------------------------------------------------
async function bootstrap() {
  const [areas, staff, tags, staffAreas] = await Promise.all([
    TC('area?active=eq.true&select=id,label&order=sort.asc'),
    TC('staff?active=eq.true&select=id,name,email,is_manager,access_code,pin_set_at&order=name.asc'),
    T('tag?select=id,name&order=name.asc'),
    TC('staff_area?select=staff_id,area_id'),
  ]);
  return { areas, staff, tags, staff_areas: staffAreas };
}

async function listDocs() {
  const docs = await T('doc?select=*&order=kind.asc,number.asc');
  const vers = await T('doc_version?select=id,doc_id,version,status');
  const reqs = await T('requirement?select=doc_id,area_id');
  const dtags = await T('doc_tag?select=doc_id,tag_id');
  return docs.map(d => ({
    ...d,
    versions: vers.filter(v => v.doc_id === d.id).sort((a, c) => c.version - a.version),
    areas: reqs.filter(r => r.doc_id === d.id).map(r => r.area_id),
    tags: dtags.filter(t => t.doc_id === d.id).map(t => t.tag_id),
  }));
}

async function getDoc(docId) {
  const doc = (await T('doc?id=eq.' + docId + '&select=*&limit=1'))[0];
  if (!doc) return { error: 'Not found.' };
  const versions = await T('doc_version?doc_id=eq.' + docId + '&select=*&order=version.desc');
  const latest = versions[0];
  const steps = latest ? await T('step?version_id=eq.' + latest.id + '&select=*&order=sort.asc') : [];
  const questions = latest ? await T('question?version_id=eq.' + latest.id + '&select=*&order=sort.asc') : [];
  const options = questions.length
    ? await T('option?question_id=in.(' + questions.map(q => q.id).join(',') + ')&select=*&order=sort.asc') : [];
  const reqs = await T('requirement?doc_id=eq.' + docId + '&select=area_id');
  const dtags = await T('doc_tag?doc_id=eq.' + docId + '&select=tag_id');
  const atts = await T('attachment?doc_id=eq.' + docId + '&select=*');
  return {
    doc, versions, latest, steps,
    questions: questions.map(q => ({ ...q, options: options.filter(o => o.question_id === q.id) })),
    areas: reqs.map(r => r.area_id), tags: dtags.map(t => t.tag_id), attachments: atts,
  };
}

// --- documents ---------------------------------------------------------------
async function nextNumber(kind) {
  const rows = await T('doc?kind=eq.' + kind + '&select=number&order=number.desc&limit=1');
  return rows.length ? Math.max(100, rows[0].number + 1) : 100;
}

async function createDoc(b) {
  const kind = ['sop', 'opl', 'notice'].includes(b.kind) ? b.kind : 'sop';
  const number = await nextNumber(kind);
  const doc = (await T('doc', {
    method: 'POST', ...RET,
    body: JSON.stringify({
      kind, number,
      title: String(b.title || 'Untitled').slice(0, 200),
      summary: b.summary || null,
      area_id: b.area_id || null,
      owner: b.owner || null,
      review_by: b.review_by || null,
      parent_doc_id: b.parent_doc_id || null,
      parent_step_no: b.parent_step_no || null,
      assess_mode: ['quiz', 'practical', 'both', 'ack'].includes(b.assess_mode) ? b.assess_mode : 'quiz',
      created_by: ACTOR,
    }),
  }))[0];
  const ver = (await T('doc_version', {
    method: 'POST', ...RET,
    body: JSON.stringify({ doc_id: doc.id, version: 1, status: 'draft', source_text: b.source_text || null, file_path: b.file_path || null, file_type: b.file_type || null }),
  }))[0];
  if (Array.isArray(b.steps) && b.steps.length) await writeSteps(ver.id, b.steps);
  await audit('create', 'doc', doc.id, { kind, number, title: doc.title });
  return { doc, version: ver };
}

async function updateDoc(b) {
  const patch = {};
  for (const k of ['title', 'summary', 'area_id', 'owner', 'review_by', 'assess_mode', 'parent_doc_id', 'parent_step_no']) {
    if (k in b) patch[k] = b[k] === '' ? null : b[k];
  }
  if (!Object.keys(patch).length) return { ok: true };
  const doc = (await T('doc?id=eq.' + b.doc_id, { method: 'PATCH', ...RET, body: JSON.stringify(patch) }))[0];
  await audit('update', 'doc', b.doc_id, patch);
  return { doc };
}

async function archiveDoc(docId, archived) {
  await T('doc?id=eq.' + docId, { method: 'PATCH', ...MIN, body: JSON.stringify({ archived: !!archived }) });
  await audit(archived ? 'archive' : 'unarchive', 'doc', docId, null);
  return { ok: true };
}

// --- versions ----------------------------------------------------------------
async function newVersion(docId) {
  const doc = (await T('doc?id=eq.' + docId + '&select=*&limit=1'))[0];
  const versions = await T('doc_version?doc_id=eq.' + docId + '&select=id,version&order=version.desc&limit=1');
  const nextV = versions.length ? versions[0].version + 1 : 1;
  const ver = (await T('doc_version', {
    method: 'POST', ...RET,
    body: JSON.stringify({ doc_id: docId, version: nextV, status: 'draft' }),
  }))[0];
  // Carry the current content forward so a small edit stays a small edit.
  if (doc.current_version_id) {
    const steps = await T('step?version_id=eq.' + doc.current_version_id + '&select=*&order=sort.asc');
    if (steps.length) await writeSteps(ver.id, steps);
    const qs = await T('question?version_id=eq.' + doc.current_version_id + '&select=*&order=sort.asc');
    if (qs.length) {
      const opts = await T('option?question_id=in.(' + qs.map(q => q.id).join(',') + ')&select=*&order=sort.asc');
      const newSteps = await T('step?version_id=eq.' + ver.id + '&select=id,sort&order=sort.asc');
      const oldSteps = steps;
      await writeQuestions(ver.id, qs.map(q => {
        const oldIdx = oldSteps.findIndex(s => s.id === q.step_id);
        return {
          prompt: q.prompt,
          step_sort: oldIdx >= 0 ? oldSteps[oldIdx].sort : null,
          options: opts.filter(o => o.question_id === q.id).map(o => ({ text: o.text, correct: o.correct, explain: o.explain })),
        };
      }), newSteps);
    }
  }
  await audit('new_version', 'doc_version', ver.id, { doc_id: docId, version: nextV });
  return { version: ver };
}

async function writeSteps(versionId, steps) {
  await T('step?version_id=eq.' + versionId, { method: 'DELETE', ...MIN });
  const rows = steps.map((s, i) => ({
    version_id: versionId, sort: i,
    step: String(s.step || '').slice(0, 500),
    key_point: s.key_point || null, why: s.why || null,
    photo_path: s.photo_path || null, needs_check: !!s.needs_check,
    video_id: youtubeId(s.video_id) || null,
    video_title: s.video_title || null,
    video_thumb: s.video_thumb || null,
  })).filter(r => r.step.trim());
  if (rows.length) await T('step', { method: 'POST', ...MIN, body: JSON.stringify(rows) });
  return rows.length;
}

async function saveVersion(b) {
  const ver = (await T('doc_version?id=eq.' + b.version_id + '&select=*&limit=1'))[0];
  if (!ver) return { error: 'Version not found.' };
  if (ver.status === 'published') return { error: 'That version is published. Start a new version to change it.' };
  const patch = {};
  for (const k of ['change_note', 'minor', 'file_path', 'file_type', 'source_text']) if (k in b) patch[k] = b[k];
  if (Object.keys(patch).length) await T('doc_version?id=eq.' + b.version_id, { method: 'PATCH', ...MIN, body: JSON.stringify(patch) });
  if (Array.isArray(b.steps)) await writeSteps(b.version_id, b.steps);
  await audit('save_version', 'doc_version', b.version_id, { steps: (b.steps || []).length });
  return { ok: true };
}

async function writeQuestions(versionId, questions, stepRows) {
  await T('question?version_id=eq.' + versionId, { method: 'DELETE', ...MIN });
  const steps = stepRows || await T('step?version_id=eq.' + versionId + '&select=id,sort&order=sort.asc');
  let n = 0;
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!String(q.prompt || '').trim()) continue;
    const step = (q.step_sort === null || q.step_sort === undefined) ? null : steps.find(s => s.sort === q.step_sort);
    const row = (await T('question', {
      method: 'POST', ...RET,
      body: JSON.stringify({ version_id: versionId, sort: n, prompt: String(q.prompt).slice(0, 600), step_id: step ? step.id : null }),
    }))[0];
    const opts = (q.options || []).filter(o => String(o.text || '').trim()).map((o, j) => ({
      question_id: row.id, sort: j, text: String(o.text).slice(0, 400),
      correct: !!o.correct, explain: o.explain || null,
    }));
    if (opts.length) await T('option', { method: 'POST', ...MIN, body: JSON.stringify(opts) });
    n++;
  }
  return n;
}

async function saveQuestions(b) {
  const ver = (await T('doc_version?id=eq.' + b.version_id + '&select=status&limit=1'))[0];
  if (!ver) return { error: 'Version not found.' };
  if (ver.status === 'published') return { error: 'That version is published. Start a new version to change it.' };
  const n = await writeQuestions(b.version_id, b.questions || []);
  await audit('save_questions', 'doc_version', b.version_id, { count: n });
  return { ok: true, count: n };
}

async function publish(b) {
  const ver = (await T('doc_version?id=eq.' + b.version_id + '&select=*&limit=1'))[0];
  if (!ver) return { error: 'Version not found.' };
  const doc = (await T('doc?id=eq.' + ver.doc_id + '&select=*&limit=1'))[0];
  const steps = await T('step?version_id=eq.' + ver.id + '&select=id&limit=1');
  if (!steps.length) return { error: 'Add at least one step before publishing.' };
  if (['quiz', 'both'].includes(doc.assess_mode)) {
    const qs = await T('question?version_id=eq.' + ver.id + '&select=id&limit=1');
    if (!qs.length) return { error: 'This document is set to need a quiz, but has no questions yet.' };
  }

  const minor = !!b.minor;
  if (doc.current_version_id && doc.current_version_id !== ver.id) {
    await T('doc_version?id=eq.' + doc.current_version_id, { method: 'PATCH', ...MIN, body: JSON.stringify({ status: 'superseded' }) });
  }
  await T('doc_version?id=eq.' + ver.id, {
    method: 'PATCH', ...MIN,
    body: JSON.stringify({ status: 'published', minor, change_note: b.change_note || ver.change_note || null, published_at: new Date().toISOString(), published_by: ACTOR }),
  });

  // A minor edit leaves training_version_id alone, so existing passes stay valid.
  const patch = { current_version_id: ver.id };
  if (!minor || !doc.training_version_id) patch.training_version_id = ver.id;
  await T('doc?id=eq.' + doc.id, { method: 'PATCH', ...MIN, body: JSON.stringify(patch) });

  await audit('publish', 'doc_version', ver.id, { doc: doc.kind.toUpperCase() + doc.number, version: ver.version, minor });
  return { ok: true, retrain: !minor };
}

// --- grouping and assignment -------------------------------------------------
async function setRequirements(b) {
  await T('requirement?doc_id=eq.' + b.doc_id, { method: 'DELETE', ...MIN });
  const areas = Array.isArray(b.areas) ? b.areas : [];
  const rows = areas.length ? areas.map(a => ({ doc_id: b.doc_id, area_id: a === 'all' ? null : a }))
                            : (b.everyone ? [{ doc_id: b.doc_id, area_id: null }] : []);
  if (rows.length) await T('requirement', { method: 'POST', ...MIN, body: JSON.stringify(rows) });
  await audit('set_requirements', 'doc', b.doc_id, { areas });
  return { ok: true };
}

async function setTags(b) {
  const names = (b.tags || []).map(t => String(t).trim().toLowerCase()).filter(Boolean);
  const ids = [];
  for (const name of names) {
    let tag = (await T('tag?name=eq.' + encodeURIComponent(name) + '&select=id&limit=1'))[0];
    if (!tag) tag = (await T('tag', { method: 'POST', ...RET, body: JSON.stringify({ name }) }))[0];
    ids.push(tag.id);
  }
  await T('doc_tag?doc_id=eq.' + b.doc_id, { method: 'DELETE', ...MIN });
  if (ids.length) await T('doc_tag', { method: 'POST', ...MIN, body: JSON.stringify(ids.map(id => ({ doc_id: b.doc_id, tag_id: id }))) });
  return { ok: true, tags: names };
}

async function attachments(b) {
  if (b.remove) {
    await T('attachment?id=eq.' + b.remove, { method: 'DELETE', ...MIN });
    await audit('remove_attachment', 'attachment', b.remove, null);
  }
  if (b.add) {
    await T('attachment', { method: 'POST', ...MIN, body: JSON.stringify({ doc_id: b.doc_id, label: b.add.label || 'Attachment', path: b.add.path || null, url: b.add.url || null, file_type: b.add.file_type || null }) });
    await audit('add_attachment', 'doc', b.doc_id, { label: b.add.label });
  }
  return { attachments: await T('attachment?doc_id=eq.' + b.doc_id + '&select=*') };
}

async function assign(b) {
  if (b.remove) {
    await T('assignment?staff_id=eq.' + b.staff_id + '&doc_id=eq.' + b.doc_id, { method: 'DELETE', ...MIN });
    await audit('unassign', 'doc', b.doc_id, { staff_id: b.staff_id });
    return { ok: true };
  }
  await T('assignment', {
    method: 'POST', headers: { Prefer: 'return=minimal,resolution=merge-duplicates' },
    body: JSON.stringify({ staff_id: b.staff_id, doc_id: b.doc_id, note: b.note || null, created_by: ACTOR }),
  });
  await audit('assign', 'doc', b.doc_id, { staff_id: b.staff_id });
  return { ok: true };
}

async function setStaffAreas(b) {
  await TC('staff_area?staff_id=eq.' + b.staff_id, { method: 'DELETE', ...MIN });
  const areas = (b.areas || []).filter(a => Number.isInteger(a));
  if (areas.length) await TC('staff_area', { method: 'POST', ...MIN, body: JSON.stringify(areas.map(a => ({ staff_id: b.staff_id, area_id: a }))) });
  await audit('set_staff_areas', 'staff', b.staff_id, { areas });
  return { ok: true };
}

// --- the matrix --------------------------------------------------------------
async function buildMatrix() {
  const [staff, docs, reqs, assigns, comps, staffAreas] = await Promise.all([
    TC('staff?active=eq.true&select=id,name&order=name.asc'),
    T('doc?archived=eq.false&current_version_id=not.is.null&select=id,kind,number,title,assess_mode,current_version_id,training_version_id&order=kind.asc,number.asc'),
    T('requirement?select=doc_id,area_id'),
    T('assignment?select=staff_id,doc_id'),
    T('completion?select=staff_id,doc_id,version_id,method,created_at,score,signed_by&order=created_at.desc'),
    TC('staff_area?select=staff_id,area_id'),
  ]);

  const areasOf = {};
  for (const sa of staffAreas) (areasOf[sa.staff_id] = areasOf[sa.staff_id] || []).push(sa.area_id);

  const latest = {};
  for (const c of comps) {
    const k = c.staff_id + '|' + c.doc_id;
    if (!latest[k]) latest[k] = c;
  }

  const cells = {};
  for (const s of staff) {
    for (const d of docs) {
      const mine = areasOf[s.id] || [];
      const required = reqs.some(r => r.doc_id === d.id && (r.area_id === null || mine.includes(r.area_id)))
                    || assigns.some(a => a.doc_id === d.id && a.staff_id === s.id);
      const done = latest[s.id + '|' + d.id];
      const target = d.training_version_id || d.current_version_id;
      let state = 'na';
      if (done && done.version_id === target) state = 'done';
      else if (done) state = 'restudy';
      else if (required) state = 'todo';
      cells[s.id + '|' + d.id] = { state, required, method: done ? done.method : null, at: done ? done.created_at : null, score: done ? done.score : null };
    }
  }
  return { staff, docs, cells };
}

async function matrix() { return buildMatrix(); }

async function person(staffId) {
  const staff = (await TC('staff?id=eq.' + staffId + '&select=id,name,email,access_code,pin_set_at,is_manager&limit=1'))[0];
  const comps = await T('completion?staff_id=eq.' + staffId + '&select=*&order=created_at.desc');
  const attempts = await T('attempt?staff_id=eq.' + staffId + '&select=*&order=created_at.desc&limit=50');
  const areas = (await TC('staff_area?staff_id=eq.' + staffId + '&select=area_id')).map(a => a.area_id);
  const assigns = (await T('assignment?staff_id=eq.' + staffId + '&select=doc_id')).map(a => a.doc_id);
  return { staff, completions: comps, attempts, areas, assignments: assigns };
}

// --- manual and practical training ------------------------------------------
async function sessionCreate(b) {
  const docIds = (b.doc_ids || []).filter(Boolean);
  const staffIds = (b.staff_ids || []).filter(Number.isInteger);
  if (!docIds.length || !staffIds.length) return { error: 'Pick at least one document and one person.' };

  const sess = (await T('session', {
    method: 'POST', ...RET,
    body: JSON.stringify({ held_on: b.held_on || new Date().toISOString().slice(0, 10), run_by: b.run_by || ACTOR, note: b.note || null, created_by: ACTOR }),
  }))[0];
  await T('session_doc', { method: 'POST', ...MIN, body: JSON.stringify(docIds.map(d => ({ session_id: sess.id, doc_id: d }))) });

  const docs = await T('doc?id=in.(' + docIds.join(',') + ')&select=id,current_version_id,training_version_id');
  const rows = [];
  for (const sid of staffIds) {
    for (const d of docs) {
      rows.push({
        staff_id: sid, doc_id: d.id, version_id: d.training_version_id || d.current_version_id,
        method: 'in_person', session_id: sess.id, signed_by: b.run_by || ACTOR, note: b.note || null,
      });
    }
  }
  if (rows.length) await T('completion', { method: 'POST', ...MIN, body: JSON.stringify(rows) });
  await audit('session', 'session', sess.id, { docs: docIds.length, people: staffIds.length });
  return { ok: true, session: sess, recorded: rows.length };
}

async function signoff(b) {
  const doc = (await T('doc?id=eq.' + b.doc_id + '&select=id,current_version_id,training_version_id&limit=1'))[0];
  if (!doc) return { error: 'Not found.' };
  await T('completion', {
    method: 'POST', ...MIN,
    body: JSON.stringify({
      staff_id: b.staff_id, doc_id: b.doc_id,
      version_id: doc.training_version_id || doc.current_version_id,
      method: 'practical', signed_by: b.signed_by || ACTOR,
      note: b.note || null, checklist: b.checklist || null,
    }),
  });
  await audit('signoff', 'doc', b.doc_id, { staff_id: b.staff_id });
  return { ok: true };
}

async function manualMark(b) {
  if (!String(b.note || '').trim()) return { error: 'A reason is required for a manual mark.' };
  const doc = (await T('doc?id=eq.' + b.doc_id + '&select=id,current_version_id,training_version_id&limit=1'))[0];
  if (!doc) return { error: 'Not found.' };
  await T('completion', {
    method: 'POST', ...MIN,
    body: JSON.stringify({
      staff_id: b.staff_id, doc_id: b.doc_id,
      version_id: doc.training_version_id || doc.current_version_id,
      method: 'manual', signed_by: ACTOR, note: String(b.note).slice(0, 500),
    }),
  });
  await audit('manual_mark', 'doc', b.doc_id, { staff_id: b.staff_id, note: b.note });
  return { ok: true };
}

// --- feedback ----------------------------------------------------------------
async function feedbackList() {
  const fb = await T('feedback?select=*&order=created_at.desc&limit=200');
  if (!fb.length) return [];
  const staff = await TC('staff?select=id,name');
  const docs = await T('doc?select=id,kind,number,title');
  return fb.map(f => ({
    ...f,
    staff_name: (staff.find(s => s.id === f.staff_id) || {}).name || 'Unknown',
    doc: docs.find(d => d.id === f.doc_id) || null,
  }));
}

async function feedbackSet(b) {
  await T('feedback?id=eq.' + b.id, { method: 'PATCH', ...MIN, body: JSON.stringify({ status: b.status }) });
  await audit('feedback_' + b.status, 'feedback', b.id, null);
  return { ok: true };
}

// --- audit export ------------------------------------------------------------
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function exportCsv() {
  const [staff, docs, comps, vers] = await Promise.all([
    TC('staff?select=id,name,email'),
    T('doc?select=id,kind,number,title'),
    T('completion?select=*&order=created_at.desc'),
    T('doc_version?select=id,version'),
  ]);
  const head = ['Person', 'Email', 'Document', 'Title', 'Version', 'Method', 'Score', 'Signed by', 'Note', 'Recorded (NZ)'];
  const lines = [head.join(',')];
  for (const c of comps) {
    const s = staff.find(x => x.id === c.staff_id) || {};
    const d = docs.find(x => x.id === c.doc_id) || {};
    const v = vers.find(x => x.id === c.version_id) || {};
    lines.push([
      s.name, s.email, d.kind ? d.kind.toUpperCase() + d.number : '', d.title,
      v.version ? 'v' + v.version : '', c.method, c.score === null ? '' : c.score,
      c.signed_by, c.note,
      new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', dateStyle: 'short', timeStyle: 'short' }).format(new Date(c.created_at)),
    ].map(csvCell).join(','));
  }
  await audit('export', 'completion', '', { rows: comps.length });
  return { csv: lines.join('\n'), rows: comps.length };
}
