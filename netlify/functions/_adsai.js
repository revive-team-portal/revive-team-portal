// Claude calls for the Ads app. Cheap model per frame, expensive model once per
// ad for the judgement call. Every prompt asks for strict JSON and every reply
// is parsed defensively — a tagging failure must downgrade one ad, not the run.

const KEY = process.env.ANTHROPIC_API_KEY;
const API = 'https://api.anthropic.com/v1/messages';

async function claude(model, system, content, max_tokens) {
  if (!KEY) throw new Error('missing ANTHROPIC_API_KEY');
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: max_tokens || 2048, system, messages: [{ role: 'user', content }] }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('claude ' + res.status + ': ' + String((j.error && j.error.message) || '').slice(0, 200));
  return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
}

// Models happily wrap JSON in prose or a fence; take the outermost object.
function parseJson(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}

const img = (b64) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });

const TAXONOMY = `Tag against this fixed taxonomy. Do not invent values outside it.
- format: one of founder_to_camera | product_only | hands_in_frame | text_on_screen | mix
- lighting: one of natural | soft | harsh | dim | mixed
- shoot_type: one of phone | lit_shoot | mixed
- visible_claims: short phrases actually shown or said, e.g. "high protein", "plant-based", "gluten free", "40% off". Only claims genuinely present.
This is a New Zealand plant-based food brand (Revive Cafe). "Wopples" are gourmet toaster waffles.`;

// --- opening 3 seconds: the hook -------------------------------------------
async function tagOpening(model, frames, fps) {
  const content = [{ type: 'text', text:
`These are the first 3 seconds of a video ad, in order, ${fps} frames per second (frame 0 = t=0s).
${TAXONOMY}

Return ONLY JSON:
{"product_in_first_3s": true|false,
 "first_product_frame": <index of the first frame showing the product, or null>,
 "onscreen_text_open": "<burned-in on-screen text visible in these frames, deduplicated, in reading order>",
 "hook_words": "<the exact words on screen in the opening, verbatim>",
 "opens_on": "face|product|text|scene|other",
 "format_hint": "<one format value>"}` }];
  frames.forEach(f => content.push(img(f)));
  return parseJson(await claude(model, 'You tag advertising creative precisely and literally. You never guess at text you cannot read.', content, 1200)) || {};
}

// --- the whole timeline -----------------------------------------------------
async function tagTimeline(model, frames, times) {
  const content = [{ type: 'text', text:
`These are frames sampled across a video ad, in order. Frame timestamps in seconds: ${JSON.stringify(times)}.
${TAXONOMY}

Return ONLY JSON:
{"format": "<one format value>",
 "lighting": "<one lighting value>",
 "shoot_type": "<one shoot_type value>",
 "subtitles_present": true|false,
 "hands_in_frame": true|false,
 "toaster_or_plate": true|false,
 "eating_on_camera": true|false,
 "product_frames": [<indices of frames where the product is clearly visible>],
 "visible_claims": ["..."],
 "onscreen_text": "<all burned-in on-screen text across these frames, deduplicated, in reading order>",
 "summary": "<one sentence describing what happens in the ad>"}` }];
  frames.forEach(f => content.push(img(f)));
  return parseJson(await claude(model, 'You tag advertising creative precisely and literally. You never guess at text you cannot read.', content, 2000)) || {};
}

// --- a still ad -------------------------------------------------------------
async function tagStill(model, frame) {
  const content = [{ type: 'text', text:
`This is a single still image ad.
${TAXONOMY}

Return ONLY JSON:
{"format": "<one format value>",
 "lighting": "<one lighting value>",
 "shoot_type": "<one shoot_type value>",
 "product_visible": true|false,
 "toaster_or_plate": true|false,
 "eating_on_camera": true|false,
 "hands_in_frame": true|false,
 "visible_claims": ["..."],
 "onscreen_text": "<all text visible in the image, in reading order>",
 "summary": "<one sentence describing the image>"}` }, img(frame)];
  return parseJson(await claude(model, 'You tag advertising creative precisely and literally.', content, 1200)) || {};
}

// --- brand glossary pass on the raw transcript ------------------------------
// whisper reliably mangles brand nouns ("Wopples" -> "waffles"). The on-screen
// text usually spells them correctly, so it is given as evidence.
async function fixTranscript(model, transcript, onscreen, glossary) {
  if (!transcript || !transcript.trim()) return { text: transcript || '', fixes: [] };
  const content = [{ type: 'text', text:
`Correct only misheard brand and product words in this automatic transcript. Do not rewrite, shorten, punctuate differently, or improve the wording. If a word is already correct, leave it.

Brand vocabulary: ${JSON.stringify(glossary)}
Text burned into the video (usually spelled correctly, use as evidence): ${JSON.stringify((onscreen || '').slice(0, 1500))}

Transcript:
${transcript.slice(0, 6000)}

Return ONLY JSON: {"text": "<corrected transcript>", "fixes": [{"from": "...", "to": "..."}]}` }];
  return parseJson(await claude(model, 'You correct speech-recognition errors conservatively.', content, 3000)) || { text: transcript, fixes: [] };
}

// --- the judgement call -----------------------------------------------------
// Six dimensions, each with a fixed definition so scores mean the same thing
// from ad to ad. Anything under 8 has to come with a specific fix — a low score
// with no instruction attached is just an opinion.
const SCORE_DEFS = {
  hook: 'HOOK — the first 3 seconds. Does it stop the scroll? Judge the opening frame, the first words spoken or shown, and whether there is a reason to keep watching.',
  clarity: 'CLARITY — is it obvious what is being sold and what the viewer should do? Judge how quickly a first-time viewer understands the product and the offer.',
  product_visibility: 'PRODUCT — how clearly and how appetisingly the product itself appears on screen, and how early. Judge screen time, framing and whether it looks good.',
  credibility: 'TRUST — does it feel true? Judge proof, specificity, real people, and whether claims are supported rather than asserted.',
  craft: 'CRAFT — production quality. Judge framing, lighting, audio, pacing, edit rhythm, subtitle legibility.',
  overall: 'OVERALL — would you put more money behind this ad as it stands? This is a judgement, not an average of the others.',
};

async function analyse(model, ad, tags, perf) {
  const content = [{ type: 'text', text:
`Assess one advertisement for a New Zealand plant-based food brand (Revive Cafe).

AD
name: ${ad.ad_name}
campaign: ${ad.campaign_name} / ad set: ${ad.adset_name}
media: ${ad.media_type}${ad.duration_sec ? ', ' + ad.duration_sec + 's' : ''}
headline: ${JSON.stringify(ad.headline)}
body copy: ${JSON.stringify((ad.body || '').slice(0, 900))}
landing page: ${ad.landing_page || 'none'}

CREATIVE TAGS
${JSON.stringify(tags, null, 1).slice(0, 2500)}

SPOKEN WORDS
${JSON.stringify((tags.transcript || '').slice(0, 2500))}

ON-SCREEN TEXT
${JSON.stringify((tags.onscreen_text || '').slice(0, 1200))}

PERFORMANCE
Hook rate is 3-second plays over impressions; hold rate is ThruPlays over 3-second
plays. Purchases are split by attribution window — do not blend them. Low spend
means low confidence: say so rather than over-reading a small sample.
${JSON.stringify(perf, null, 1).slice(0, 1200)}

SCORE DEFINITIONS (0-10, score against these and nothing else)
${Object.values(SCORE_DEFS).join('\n')}

Return ONLY JSON:
{"observations": ["<3-6 short, concrete things you actually observed in this ad — what happens on screen, what is said, what the numbers show. One fact each, no advice here, under 20 words each>"],
 "scores": {"hook": n, "clarity": n, "product_visibility": n, "credibility": n, "craft": n, "overall": n},
 "score_notes": {"<only dimensions scoring below 8>": "<one specific instruction to fix that dimension, under 15 words, an action not a restatement>"},
 "recommendation": "<one or two sentences: what to do with this ad overall and why>",
 "confidence": "high|medium|low"}` }];
  return parseJson(await claude(model, 'You are a direct-response creative strategist. You separate what you saw from what you advise. You are specific, you cite what is actually in the ad, and you never pad.', content, 2000)) || {};
}

module.exports = { claude, parseJson, tagOpening, tagTimeline, tagStill, fixTranscript, analyse, SCORE_DEFS };
