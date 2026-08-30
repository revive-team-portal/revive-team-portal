// AI drafting for the Training app: turn an existing laminated SOP (PDF, photo
// of the wall, or pasted text) into the standard step / key point / why format,
// and suggest questions from it.
//
// Hard rule, enforced in the prompt and checked below: it must NEVER invent a
// number, temperature, time or weight. Anything it cannot read is returned with
// needs_check = true so a human fills it in. Nothing here publishes anything.

const { json, validatePortalUser } = require('./_portal');

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

const DRAFT_SYSTEM = `You convert existing workplace Standard Operating Procedures into a structured format for a New Zealand cafe and food production business (Revive).

Return ONLY valid JSON, no prose, no code fences, matching:
{
  "title": "short title, max 60 chars",
  "summary": "one sentence saying what this procedure is for",
  "suggested_tags": ["lowercase", "words"],
  "steps": [
    { "step": "the action, imperative, max 12 words",
      "key_point": "the thing that makes or breaks it - a limit, a measurement, a check",
      "why": "why that key point matters, in plain language a new staff member understands",
      "needs_check": false }
  ]
}

Rules you must follow:
1. NEVER invent or guess a number, temperature, time, weight, dose or concentration. If the source is unclear or unreadable on a value, write the field with the words you can read, put "[CHECK]" where the value should be, and set "needs_check": true for that step.
2. Do not add steps that are not in the source. Do not merge two different checks into one step.
3. If the source explains WHY something matters, use that. If it does not, you may add a brief, well-established food-safety or equipment-safety reason - but if you are not confident, leave "why" as an empty string rather than inventing a mechanism.
4. Aim for 4-7 steps. If the source genuinely has more, keep them, but never pad.
5. Keep "key_point" under about 15 words. Plain English, no jargon a new starter would not know.
6. If the source appears to contain two different procedures, put only the first in steps and note it in "summary".`;

const QUESTION_SYSTEM = `You write short assessment questions for staff training on a workplace procedure, for a New Zealand cafe and food production business.

Return ONLY valid JSON, no prose, no code fences:
{ "questions": [
  { "prompt": "the question",
    "step_sort": 0,
    "options": [ { "text": "an answer", "correct": true, "explain": "why this is right or wrong" } ] }
] }

Rules:
1. Write 6 questions. Each has exactly 4 options, exactly one correct.
2. Prefer questions about JUDGEMENT ON THE JOB over recall of numbers. "You come back and the soup is still at 40C after two hours - what do you do?" is a good question. "How many minutes?" is a weak one. At most 2 of the 6 should be pure number recall.
3. EVERY option needs an "explain" - for the correct one, why it is right; for the wrong ones, why that choice is wrong and what would go wrong if you did it. Base these on the "why" text of the step wherever possible.
4. Wrong options must be plausible things a real staff member might actually do. Never joke options.
5. "step_sort" is the sort number of the step the question comes from.
6. Never introduce a number, temperature or time that is not in the source steps.`;

async function callClaude(system, content, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens || 3000, system, messages: [{ role: 'user', content }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error && data.error.message) || ('AI request failed (' + res.status + ')'));
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  return text;
}

function parseJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('The AI did not return usable data. Try pasting the text instead.');
  return JSON.parse(t.slice(start, end + 1));
}

// Belt and braces: if a value looks unreadable, force needs_check on regardless
// of what the model said.
function flagUnchecked(steps) {
  return steps.map(s => {
    const blob = [s.step, s.key_point, s.why].join(' ');
    const suspicious = /\[CHECK\]|\?\?|_{2,}|\bTBC\b/i.test(blob);
    return { ...s, needs_check: !!s.needs_check || suspicious };
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!KEY) return json(500, { error: 'Server not configured (ANTHROPIC_API_KEY).' });

  const auth = await validatePortalUser(event, 'training');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });

  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }

  try {
    if (b.action === 'draft') {
      const content = [];
      const files = Array.isArray(b.files) ? b.files.slice(0, 5) : [];
      for (const f of files) {
        const m = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(f || '');
        if (!m) continue;
        if (m[1] === 'application/pdf') {
          content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: m[2] } });
        } else if (/^image\//.test(m[1])) {
          content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
        }
      }
      const pasted = String(b.text || '').trim();
      if (pasted) content.push({ type: 'text', text: 'Existing SOP text:\n\n' + pasted.slice(0, 20000) });
      if (!content.length) return json(400, { error: 'Upload a file or paste the SOP text first.' });

      content.push({ type: 'text', text: 'Convert the above into the JSON format described. Remember: never invent a number.' });

      const out = parseJson(await callClaude(DRAFT_SYSTEM, content, 3000));
      const steps = flagUnchecked(Array.isArray(out.steps) ? out.steps : []);
      return json(200, {
        title: String(out.title || '').slice(0, 200),
        summary: String(out.summary || '').slice(0, 500),
        suggested_tags: (out.suggested_tags || []).slice(0, 6),
        steps,
        needs_check_count: steps.filter(s => s.needs_check).length,
      });
    }

    if (b.action === 'questions') {
      const steps = Array.isArray(b.steps) ? b.steps : [];
      if (!steps.length) return json(400, { error: 'Finalise the steps first.' });
      const brief = steps.map((s, i) => `Step ${i} (sort ${s.sort !== undefined ? s.sort : i}): ${s.step}\n  Key point: ${s.key_point || '-'}\n  Why: ${s.why || '-'}`).join('\n\n');
      const out = parseJson(await callClaude(QUESTION_SYSTEM, [
        { type: 'text', text: 'Procedure: ' + (b.title || 'Untitled') + '\n\n' + brief },
        { type: 'text', text: 'Write the questions as JSON.' },
      ], 3500));
      const qs = (out.questions || []).map(q => ({
        prompt: String(q.prompt || '').slice(0, 600),
        step_sort: (q.step_sort === null || q.step_sort === undefined) ? null : Number(q.step_sort),
        options: (q.options || []).slice(0, 5).map(o => ({
          text: String(o.text || '').slice(0, 400), correct: !!o.correct, explain: String(o.explain || '').slice(0, 600),
        })),
      })).filter(q => q.prompt && q.options.length >= 2 && q.options.some(o => o.correct));
      return json(200, { questions: qs });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (e) {
    return json(502, { error: String(e.message || e).slice(0, 300) });
  }
};
