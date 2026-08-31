// Staff-facing data API for /me. Gated by the staff session token (_staffauth),
// never by a portal login. A staff member can only ever read their own records.
//
// Quiz marking happens here, server-side: the browser is never sent the correct
// answers before it submits.

const { json, db, requireStaff } = require('./_staffauth');

const T = (path, opts) => db(path, opts, 'training');
const TC = (path, opts) => db(path, opts, 'timeclock');

const NZ = 'Pacific/Auckland';
const nzDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: NZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d ? new Date(d) : new Date());

const PASS_PCT = 80;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const auth = await requireStaff(event);
  if (!auth.ok) return json(auth.status, { error: auth.error });
  const me = auth.staff;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }

  try {
    switch (body.action) {
      case 'home':     return json(200, await home(me));
      case 'doc':      return json(200, await readDoc(me, body.doc_id));
      case 'search':   return json(200, { docs: await search(body.q) });
      case 'quiz':     return json(200, await quiz(me, body.doc_id));
      case 'submit':   return json(200, await submit(me, body.doc_id, body.answers));
      case 'ack':      return json(200, await acknowledge(me, body.doc_id));
      case 'feedback': return json(200, await feedback(me, body.doc_id, body.body));
      default:         return json(400, { error: 'Unknown action.' });
    }
  } catch (e) {
    return json(500, { error: String(e.message || e).slice(0, 300) });
  }
};

// --- what this person owes ---------------------------------------------------
async function myAreaIds(staffId) {
  const rows = await TC('staff_area?staff_id=eq.' + staffId + '&select=area_id');
  return rows.map(r => r.area_id);
}

// A document is required for someone if it's required of everyone, required of
// an area they work in, or assigned to them directly.
async function requiredDocIds(staffId) {
  const areas = await myAreaIds(staffId);
  const reqs = await T('requirement?select=doc_id,area_id');
  const set = new Set();
  for (const r of reqs) {
    if (r.area_id === null || areas.includes(r.area_id)) set.add(r.doc_id);
  }
  const assigns = await T('assignment?staff_id=eq.' + staffId + '&select=doc_id');
  for (const a of assigns) set.add(a.doc_id);
  return set;
}

async function home(me) {
  const docs = await T('doc?archived=eq.false&select=id,kind,number,title,summary,assess_mode,current_version_id,training_version_id&order=kind.asc,number.asc');
  const live = docs.filter(d => d.current_version_id);
  const required = await requiredDocIds(me.id);
  const comps = await T('completion?staff_id=eq.' + me.id + '&select=doc_id,version_id,method,created_at&order=created_at.desc');

  const latestFor = {};
  for (const c of comps) if (!latestFor[c.doc_id]) latestFor[c.doc_id] = c;

  const mine = [];
  for (const d of live) {
    const done = latestFor[d.id];
    // Current if they completed the version training is measured against.
    const target = d.training_version_id || d.current_version_id;
    const current = !!done && done.version_id === target;
    const stale = !!done && !current;
    if (!required.has(d.id) && !done) continue;
    mine.push({
      id: d.id, kind: d.kind, number: d.number, title: d.title, summary: d.summary,
      assess_mode: d.assess_mode,
      required: required.has(d.id),
      state: current ? 'done' : (stale ? 'restudy' : 'todo'),
      method: done ? done.method : null,
      done_at: done ? done.created_at : null,
    });
  }

  const order = { todo: 0, restudy: 1, done: 2 };
  mine.sort((a, b) => (order[a.state] - order[b.state]) || a.number - b.number);

  return {
    staff: me,
    today: nzDate(),
    items: mine,
    outstanding: mine.filter(i => i.state !== 'done').length,
    library_count: live.length,
  };
}

// --- reading -----------------------------------------------------------------
async function docBundle(docId) {
  const doc = (await T('doc?id=eq.' + docId + '&archived=eq.false&select=*&limit=1'))[0];
  if (!doc || !doc.current_version_id) return null;
  const ver = (await T('doc_version?id=eq.' + doc.current_version_id + '&select=*&limit=1'))[0];
  if (!ver || ver.status !== 'published') return null;
  const steps = await T('step?version_id=eq.' + ver.id + '&select=*&order=sort.asc');
  const tags = await T('doc_tag?doc_id=eq.' + docId + '&select=tag_id');
  const atts = await T('attachment?doc_id=eq.' + docId + '&select=id,label,url,path,file_type');
  return { doc, ver, steps, tags, atts };
}

async function readDoc(me, docId) {
  const b = await docBundle(docId);
  if (!b) return { error: 'That document is not available.' };
  const comps = await T('completion?staff_id=eq.' + me.id + '&doc_id=eq.' + docId + '&select=version_id,method,created_at&order=created_at.desc&limit=1');
  const qcount = (await T('question?version_id=eq.' + b.ver.id + '&select=id')).length;
  const target = b.doc.training_version_id || b.doc.current_version_id;
  return {
    doc: {
      id: b.doc.id, kind: b.doc.kind, number: b.doc.number, title: b.doc.title,
      summary: b.doc.summary, owner: b.doc.owner, review_by: b.doc.review_by,
      assess_mode: b.doc.assess_mode,
    },
    version: { id: b.ver.id, version: b.ver.version, published_at: b.ver.published_at, file_path: b.ver.file_path },
    steps: b.steps.map(s => ({ id: s.id, sort: s.sort, step: s.step, key_point: s.key_point, why: s.why,
      photo_path: s.photo_path, video_id: s.video_id, video_title: s.video_title, video_thumb: s.video_thumb,
      video_path: s.video_path, video_poster: s.video_poster, video_secs: s.video_secs })),
    attachments: b.atts,
    question_count: qcount,
    my_completion: comps[0] || null,
    up_to_date: !!comps[0] && comps[0].version_id === target,
  };
}

async function search(q) {
  const term = String(q || '').trim();
  let path = 'doc?archived=eq.false&current_version_id=not.is.null&select=id,kind,number,title,summary&order=kind.asc,number.asc&limit=60';
  if (term) {
    const esc = encodeURIComponent('%' + term.replace(/[%,()]/g, ' ') + '%');
    const num = /^\d+$/.test(term) ? ',number.eq.' + term : '';
    path = 'doc?archived=eq.false&current_version_id=not.is.null&or=(title.ilike.' + esc + ',summary.ilike.' + esc + num + ')&select=id,kind,number,title,summary&order=kind.asc,number.asc&limit=60';
  }
  return T(path);
}

// --- assessment --------------------------------------------------------------
async function quiz(me, docId) {
  const b = await docBundle(docId);
  if (!b) return { error: 'That document is not available.' };
  if (b.doc.assess_mode === 'practical') return { error: 'This one is signed off in person by a supervisor.' };

  const qs = await T('question?version_id=eq.' + b.ver.id + '&select=id,sort,prompt,step_id&order=sort.asc');
  if (!qs.length) return { error: 'No questions have been written for this yet.' };

  const opts = await T('option?question_id=in.(' + qs.map(q => q.id).join(',') + ')&select=id,question_id,sort,text&order=sort.asc');
  const byQ = {};
  for (const o of opts) (byQ[o.question_id] = byQ[o.question_id] || []).push({ id: o.id, text: o.text });

  // Correct answers and explanations stay on the server until they submit.
  return {
    version_id: b.ver.id,
    pass_pct: PASS_PCT,
    questions: qs.map(q => ({ id: q.id, prompt: q.prompt, step_id: q.step_id, options: shuffle(byQ[q.id] || []) })),
  };
}

function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function submit(me, docId, answers) {
  const b = await docBundle(docId);
  if (!b) return { error: 'That document is not available.' };
  const qs = await T('question?version_id=eq.' + b.ver.id + '&select=id,prompt&order=sort.asc');
  if (!qs.length) return { error: 'No questions to mark.' };
  const opts = await T('option?question_id=in.(' + qs.map(q => q.id).join(',') + ')&select=id,question_id,text,correct,explain');

  const chosen = {};
  for (const a of (answers || [])) chosen[a.question_id] = a.option_id;

  const results = [];
  let score = 0;
  for (const q of qs) {
    const qOpts = opts.filter(o => o.question_id === q.id);
    const picked = qOpts.find(o => o.id === chosen[q.id]) || null;
    const right = qOpts.find(o => o.correct) || null;
    const ok = !!picked && !!picked.correct;
    if (ok) score++;
    results.push({
      question_id: q.id, prompt: q.prompt, correct: ok,
      picked_id: picked ? picked.id : null,
      correct_id: right ? right.id : null,
      // The explanation is the point of the exercise — always send it back.
      explain: (picked && picked.explain) || (right && right.explain) || null,
    });
  }

  const total = qs.length;
  const pct = total ? Math.round((score / total) * 100) : 0;
  const passed = pct >= PASS_PCT;

  await T('attempt', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ staff_id: me.id, version_id: b.ver.id, score, total, passed, answers: chosen }),
  });

  // 'both' still needs a supervisor to sign off, so a quiz pass alone
  // does not complete it.
  const completes = passed && (b.doc.assess_mode === 'quiz' || b.doc.assess_mode === 'ack');
  if (completes) {
    await T('completion', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        staff_id: me.id, doc_id: docId,
        version_id: b.doc.training_version_id || b.ver.id,
        method: 'quiz', score: pct,
      }),
    });
  }

  return {
    score, total, pct, passed, pass_pct: PASS_PCT, results,
    completed: completes,
    awaiting_signoff: passed && b.doc.assess_mode === 'both',
  };
}

async function acknowledge(me, docId) {
  const b = await docBundle(docId);
  if (!b) return { error: 'That document is not available.' };
  if (!['ack', 'notice'].includes(b.doc.assess_mode) && b.doc.kind !== 'notice' && b.doc.assess_mode !== 'ack') {
    return { error: 'This one needs the questions completed.' };
  }
  await T('completion', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      staff_id: me.id, doc_id: docId,
      version_id: b.doc.training_version_id || b.ver.id, method: 'ack',
    }),
  });
  return { ok: true };
}

async function feedback(me, docId, text) {
  const t = String(text || '').trim();
  if (t.length < 3) return { error: 'Tell us what does not match.' };
  await T('feedback', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ doc_id: docId, staff_id: me.id, body: t.slice(0, 2000) }),
  });
  return { ok: true };
}
