// Suggests next tasks for a board in the Tasks app.
//
// Keeps the Anthropic key server-side and only answers logged-in portal users with
// `tasks` access. Returns a plain array of { title, notes } — the browser holds them
// as drafts until Jeremy drags one onto a band, so nothing is written here.

const { json, validatePortalUser } = require('./_portal');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

const SYSTEM = `You suggest the next concrete actions for a business owner's task board.

Revive is a New Zealand health-food business: a wholefood cafe and online store, plus
"Wopples" — a chickpea waffle brand sold through supermarkets (Farro, New World,
Foodstuffs, Woolworths). The owner is the GM and is time-poor, so suggestions must be
things a small team can actually start this week.

Think like three specific operators, and let their thinking show in what you pick:

- Brian Tracy — bias to the single highest-consequence action. Eat the frog: the task
  that is being avoided is usually the one that matters. Apply 80/20 ruthlessly and
  prefer tasks with long-term consequences over urgent-but-trivial ones.
- Chet Holmes — pigheaded discipline on a few things done repeatedly beats novelty.
  Dream 100 (go after the best buyers relentlessly, not everyone), education-based
  marketing over pitching, and tight systems and drilling so the team executes
  the same way every time.
- Alex Hormozi — make the offer so good people feel stupid saying no. Improve the
  value equation (dream outcome, perceived likelihood of success, less time, less
  effort). Prefer volume and direct lead generation over clever indirect plays, and
  get proof and reviews working for you.

Rules for the output:
- 5 suggestions, each a specific action, not a theme. "Sample Wopples at Farro
  Pukekohe on 2 Saturdays and count conversion" beats "do more sampling".
- Do not repeat or lightly reword anything already on the board.
- Each gets a short note (under 18 words) saying why it earns its place — name the
  thinking where it genuinely applies.
- Keep the title under 70 characters.

Return ONLY minified JSON, no markdown fences:
[{"title":"...","notes":"..."}]`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!ANTHROPIC_KEY) return json(500, { error: 'Server not configured (ANTHROPIC_API_KEY).' });

  const auth = await validatePortalUser(event, 'tasks');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }

  const sheet     = String(body.sheet || '').slice(0, 80);
  const board     = String(body.board || '').slice(0, 80);
  const objective = String(body.objective || '').slice(0, 600);
  const existing  = (Array.isArray(body.existing) ? body.existing : []).slice(0, 60).map(t => String(t).slice(0, 140));

  const prompt = [
    'Sheet: ' + (sheet || '(none)'),
    'Board: ' + (board || '(none)'),
    objective ? 'Objective for this board: ' + objective
              : 'No objective set — infer a sensible one from the board name and the tasks already on it.',
    '',
    existing.length ? 'Already on this board (do not repeat these):\n- ' + existing.join('\n- ')
                    : 'The board is empty.',
  ].join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, system: SYSTEM, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return json(502, { error: (data && data.error && data.error.message) || 'AI request failed.' });

  const text = (Array.isArray(data.content) ? data.content : [])
    .filter(b => b && b.type === 'text').map(b => b.text).join('');

  let raw = text.replace(/```json|```/g, '').trim();
  const a = raw.indexOf('['), b = raw.lastIndexOf(']');
  if (a >= 0 && b > a) raw = raw.slice(a, b + 1);

  let list;
  try { list = JSON.parse(raw); } catch { return json(502, { error: 'Could not read the suggestions — try again.' }); }
  if (!Array.isArray(list)) return json(502, { error: 'Could not read the suggestions — try again.' });

  const out = list
    .filter(x => x && x.title)
    .slice(0, 8)
    .map(x => ({ title: String(x.title).slice(0, 200), notes: x.notes ? String(x.notes).slice(0, 300) : null }));

  return json(200, { suggestions: out });
};
