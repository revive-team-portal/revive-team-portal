// Server-side proxy for Claude calls (recipe import, cook-ratio estimate, etc.).
// Keeps the Anthropic key off the browser and only serves logged-in portal users with recipes access.

const { json, validatePortalUser } = require('./_portal');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!ANTHROPIC_KEY) return json(500, { error: 'Server not configured (ANTHROPIC_API_KEY).' });

  const auth = await validatePortalUser(event, 'recipes');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }
  const messages = body.messages;
  if (!Array.isArray(messages) || !messages.length) return json(400, { error: 'No messages provided.' });
  const max_tokens = Math.min(Number(body.max_tokens) || 2048, 4096);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens, messages }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return json(502, { error: (data && data.error && data.error.message) || 'AI request failed.' });

  const text = (data.content && data.content[0] && data.content[0].text) || '';
  return json(200, { text });
};
