# Revive Team Portal — Conventions & Build Rules

> Canonical build rules for the Revive Team Portal. Any Cowork/agent working on this repo must follow these. Update this file (with agreement) before changing the rule in code.

This file is the single source of truth for how portal apps are built, changed, and shipped. If a change contradicts these rules, fix the rule here first (with agreement), then the code.

## 1. What the portal is

Static HTML apps + Netlify Functions, deployed from `main` (push auto‑deploys via Netlify, live in ~30–60s). Each app is one `index.html` at `/<app>/`. Data lives in two Supabase projects.

## 2. Deploy rules (non‑negotiable)

- **Always edit from a fresh clone of `main`.** Never edit from a stale local copy — that is how the whole rostering file got reverted. Clone, edit, push, delete.
- **Never** ask a human to run a command / open Terminal; the agent pushes using the deploy token.
- Before pushing a function: run `node --check` on it and confirm every `require('./_x')` helper exists.
- **Verify live after every deploy:** poll the URL for a string you just added, and confirm function endpoints return 401/405 (not 404). Report the live URL + commit hash.

## 3. Repo layout

- Page `/<app>/` → `<app>/index.html`. Functions → `netlify/functions/<name>.js` (`exports.handler = async (event) => {…}`), reachable at `/.netlify/functions/<name>`.
- **There is a second site and second repo.** `revive-team-portal` = the staff portal at `team.revive.co.nz`. **`revive-jobs`** = the public careers site at `jobs.revive.co.nz` (`job.html`, `interview.html`, its own `netlify/functions/`). A Jobs change often needs BOTH. `jobs.revive.co.nz/<code>` short URLs are a `_redirects` rewrite — the browser keeps the path, so the page reads the code from `location.pathname`, not the query string.
- `revive-jobs` has **no `package.json`** — its functions cannot `require` any npm package. Anything needed is hand-rolled (see `_pdf.js`) or done by calling the Claude API. Adding a `package.json` changes that site's build; don't do it casually.
- Shared helpers are underscore‑prefixed (`_portal.js`, `_supa.js`, `_appsdb.js`, `_shopify.js`, …). Reuse them; don't re‑implement Supabase fetch wrappers inline.
- Shared front‑end chrome: **`/chrome.css`** (nav + loading styles + the brand green), **`/today-bar.js`** (the green status bar), **`/assets/revive-logo.png`**, **`/assets/cafe-loading.jpg`**. Change the look in **one** place, not per app.

## 4. Branding / UI consistency

- Top nav bar: class `rv-nav`, dark green **`#16543f`**, transparent Revive Cafe logo top‑left, **`← Main Portal`** link top‑right, consistent buttons (`rv-btn`). Every app.
- Loading screen: the shared café image + animated text (`rv-load`).
- Portal tile titles are **one word** (Sales, Support, Pulse…). Names live in the `apps` table (Revive Portal project).
- Give the nav and any status bars a **fixed height** so the page doesn't shift as data loads.

## 5. Security (the rules that matter)

- **Every function that reads/writes real data must gate first** with `validatePortalUser(event, '<app>')` (portal login + active + app access) or `requireAdmin(event)`. Never trust a client‑supplied `user_id`, `role`, `email`, or `is_admin`.
- **No secrets in the repo.** It is a **public** repo. No tokens, passwords, or static guard keys in HTML/JS/PS1 — use Netlify env vars. (Historic offenders: `rvp-tk-7Kq3`, `rvp-pos-9Qz4Kt`.)
- **RLS stays on** for every table, with **no** `anon`/`authenticated` policies. The browser reads nothing directly; everything goes through a function on the service‑role key. **New schema? See §9 — the exposed‑schemas setting REPLACES, it does not append.**
- *Known exception:* the **Jobs** app (`/jobs/`) talks to Supabase from the browser using an authenticated service account, and the public ad at `jobs.revive.co.nz` reads `jobs.jobs`/`jobs.settings` as `anon`. It predates this rule. Don't "fix" it casually — the public application form breaks if you revoke those grants (it already did once).
- **Escape all DB/user text before putting it in HTML.** Vue `{{ }}` is safe; raw `innerHTML`/template strings are not. The `esc()` helper **must** escape `& < > " '` (quotes included). This applies especially to anything from outside parties (email content, attachment filenames, customer names).
- Don't expose business financials or PII on unauthenticated endpoints or with `Access‑Control‑Allow‑Origin: *`.

## 6. Correctness rules (caught real bugs)

- **Dates are NZ.** Default any date to NZ (`Pacific/Auckland`), never `new Date().toISOString().slice(0,10)` (that's UTC → shows "yesterday" all NZ morning).
- **Declare every Vue `ref()` you use.** Two apps shipped a blank screen from an undeclared ref. A quick `node`/lint pass or grep for `.value` on undeclared names catches it.
- **On edit, load everything you'll save.** Don't delete‑then‑reinsert from a partially‑loaded object (this wiped recipe steps).
- **Handle query errors.** Check Supabase `error` on every call; show a retry state, not a silent empty screen. Add fetch timeouts so a hung request doesn't spin forever.
- **Mobile:** provide a touch path for anything drag‑and‑drop; no fixed widths that overflow phones; tap targets ≥ ~40px.
- **Answer the CORS preflight BEFORE the method check.** `team.revive.co.nz` calling a function on `jobs.revive.co.nz` is cross‑origin, so the browser sends `OPTIONS` first. A handler that does `if (method !== 'POST') return 405` above its `OPTIONS` branch returns 405 to the preflight and the browser blocks the real call. This silently killed interview invites; `curl` never sees it because curl doesn't preflight.
- **Check the response before declaring success.** A `fetch` that resolves is not a send that worked. Read the status and the body, and surface the actual error — the invite code reported a generic "Could not send" for every failure and treated any response as sent.
- **`window.open` after an `await` is popup‑blocked.** Open the tab synchronously in the click and set `.location` once the URL resolves, or use a plain `<a href>`. This is why document preview did nothing.
- **Match the DB column names.** The public application form posted `name` and `work_rights` when the columns were `full_name` and (missing). Every submission failed for weeks. Verify an insert round‑trips against the real schema before shipping a form.

## 7. Two Supabase projects — pick the right one

- **Revive Portal** (`zpcbtfdjcsbdeqnizrpr`): logins, `profiles`, `apps`, `user_app_access` (role gating).
- **Revive Apps** (`xcwrawjdfajlmbkdwlbm`): the app data (recipes, sales, support, production, pulse, scoreboard, tasks…).
- Functions use the service‑role keys (`PORTAL_SERVICE_ROLE_KEY`, `APPS_SERVICE_ROLE_KEY`), which bypass RLS.

## 8. Before you call a change "done"

`node --check` passed · helper requires exist · deployed to `main` · **verified live** (served string + function status) · no secret added · DB text escaped · dates are NZ · looks right on mobile. Report URL + commit hash.

**"Deployed" is not "working". Exercise the actual path end to end.** Repeatedly in this codebase the component existed and nothing called it:
- the application confirmation email was fully built — no code ever invoked it, so no applicant ever got one;
- the admin called `score-application`, which does not exist (404), so AI scoring never ran;
- the Settings → Email Templates screen saved to the DB and `send-email` ignored it, sending hardcoded copy instead;
- analysis ran 8s after submission, before the CV text existed, so it only ever read the cover letter.

So: submit the real form, click the real button, and check the row/inbox/file that should have changed. Grepping for a deployed string only proves the file shipped.

## 9. Shared global settings — read, append, verify (this has broken production twice)

`pgrst.db_schemas` is a SINGLE setting shared by every app. `ALTER ROLE ... SET`
REPLACES it. Retyping the list from memory, or copying it from an older
migration, silently unexposes every schema you left out — the tables still
exist, but the whole API returns `PGRST106 Invalid schema` and those apps go
dark.

This has happened twice:
- Adding `scoreboard` dropped `jobs` — the Jobs app died.
- Adding `checklist` dropped `jobs`, `tasks` and `timeclock` (20 Aug 2026).
  The job vanished from the admin, the public ad 404'd, and the "New job apps"
  segment disappeared from the green today bar.

ALWAYS read the live value first and append to it:

```sql
-- 1. read what is actually set right now
select rolconfig from pg_roles where rolname = 'authenticator';

-- 2. copy that exact list, add yours to the END, change nothing else
alter role authenticator set pgrst.db_schemas =
  'public, graphql_public, recipes, sales, support, production, pulse, scoreboard, jobs, tasks, timeclock, checklist, <yours>';

notify pgrst, 'reload config';

-- 3. verify every app's schema still answers before you finish
```

Never copy this list out of a migration file — migrations are snapshots and go
stale the moment the next app is added.

**Run it as a migration, not ad‑hoc SQL.** The checklist change was executed
ad‑hoc, so there is no record of it in `supabase_migrations` — only its damage.
A migration leaves an audit trail the next person can read.

**The same read‑append‑verify rule applies to every shared resource**, because
each is one global value that a careless write silently truncates for everyone:

| Shared thing | Where | Risk if you overwrite |
|---|---|---|
| `pgrst.db_schemas` | `authenticator` role | Every omitted app's API dies |
| `apps` / `user_app_access` | Revive Portal DB | Tiles vanish or access is revoked |
| `chrome.css`, `today-bar.js`, `/assets/*` | portal repo root | Restyles or breaks all 11 apps at once |
| Storage bucket policies | Revive Apps | Uploads or reads fail across apps |

After touching any of them, check the OTHER apps still work — not just yours.
The green today bar is the fastest tell: it pulls from Shopify, Meta, POS,
Support and Jobs, so a missing segment means that source is broken.

---

# Ads app (`/ads/`)

Meta ad creative, tagged and scored next to what it actually did. Data lives in
the `ads` schema on **Revive Apps** (`xcwrawjdfajlmbkdwlbm`); RLS is on with no
policies, so every read goes through a gated function.

## The one thing to know before touching it

Every video ad carries **two** Meta video ids. The published Page post's copy is
refused (`(#10) Application does not have permission`) because the token
(`reviveadsbot`) holds only `ads_read` and has no Page access. The ad-account
library copy — `creative.object_story_spec.video_data.video_id`, cross-checked
against `/act_.../advideos` — returns a real `source` mp4. **Always join through
the library.** Ads built from an already-published post have only the locked
copy, so they cannot be analysed at all; they are stored with
`media_type='video_locked'` and `analysis_state='unavailable'`.

## Pieces

| File | Does |
|---|---|
| `_adscreative.js` | Classifies media type and pulls copy/headline/landing page out of every creative shape (`object_story_spec` video/link/photo, `asset_feed_spec`, legacy flat fields) |
| `_adsmeta.js` | Meta paging with page-size backoff, live NZ→account tz offset, insights split by attribution window |
| `_adsdb.js` | `ads` schema access + `ad-frames` storage + runtime config |
| `_adsai.js` | Claude calls: frame tagging, on-screen text, brand-glossary transcript pass, scoring |
| `_adsauth.js` | Run-key guard (env `PORTAL_RUN_KEY`, or a single-use key in `ads.job`) |
| `ads-sync-background.js` | All 383 ads: metadata, copy, landing page, performance. ~70s |
| `ads-video-background.js` | One ad at a time: ffmpeg frames + audio, whisper transcript, tagging, scoring. Ships `bin/` |
| `ads-data.js` / `ads-run.js` | The page's gated read and its run trigger |
| `ads-export.js` | Key-guarded machine-readable corpus (below) |

`ads-sync-cron` and `ads-video-cron` carry the schedules. **Do not put a
`schedule` on a `-background` function** — Netlify then returns 403 to direct
HTTP calls and the page can no longer run it on demand.

## Binaries

`bin/` holds a static x86_64 `ffmpeg` plus `whisper-cli` and its shared
libraries. **Netlify functions are x86_64, glibc 2.34, Node 22, 1024 MB RAM,
513 MB of `/tmp`** — build or download for that target, not for whatever your
sandbox is. 86 MB unzipped, 31 MB zipped, scoped to the video function by
`included_files` so the other ~130 functions are untouched. There is deliberately
**no `package.json`**; `child_process` is a Node builtin, so a binary is a plain
file rather than a dependency.

The whisper weights (~148 MB) are too big to commit. They are fetched once per
cold start into `/tmp`, cached in the `ad-frames` bucket, and **only fetched at
all when the batch actually contains a video** — Supabase's free plan allows
5 GB egress a month and the model would eat most of it otherwise.

## Query it from Claude or another portal app

```
GET /.netlify/functions/ads-export?k=<PORTAL_RUN_KEY or a one-time ads.job runkey>
    &state=done|pending|unavailable|all   (default all)
    &media=video|image|carousel|video_locked
    &brand=Wopples&since=YYYY-MM-DD
    &limit=200&offset=0&fields=list|full
```

Returns `{ ok, total, offset, limit, returned, counts, media, generated_at, ads: [...] }`.
Each ad carries identity (`ad_id`, `ad_name`, `campaign_name`, `adset_name`,
`brand`, `created_time`, `permalink`), creative (`media_type`, `thumb`, `frames[]`,
`duration_sec`), copy (`body`, `headline`, `landing_page`, `body_shared`,
`headline_shared` — how many ads reuse that exact text), performance
(`spend`, `purchases_1d_click` / `purchases_7d_click` / `purchases_1d_view` kept
**separate, never blended**, `hook_rate`, `hold_rate`, `active_last_7`), and
`tags` (`format`, `lighting`, `shoot_type`, `total_cuts`, `time_to_first_cut`,
`first_product_at`, `visible_claims`, `hook_words`, `transcript`,
`onscreen_text`, `scores`, `recommendation`).

## Metric definitions (do not "simplify" these)

- **Hook rate = 3-second plays ÷ impressions.** The 3-second count is the
  `video_view` entry in the `actions` array. `video_play_actions` is an *autoplay
  start* and runs at 85-87% of impressions on this account — it looks like a
  brilliant hook rate and means nothing. `video_3_sec_watched_actions` is not a
  valid field on v21. `hook_rate_basis` records which numerator was used.
- **Hold rate = ThruPlays ÷ 3-second plays.** `thruplay_rate` (ThruPlays ÷
  impressions) is stored separately for when you want the Ads Manager figure.
- **Purchases, CPA and ROAS headline on Meta's own default: 7-day click + 1-day
  view** (`purchases_meta`, `cpa_meta`, `roas_meta`), so the app agrees with the
  Ads Manager screen. The click-only pair (`purchases_7d_click`, `cpa`, `roas`)
  is stored alongside and shown as the grey second line on every tile — the same
  ads judged on people who actually clicked. Keep both; they answer different
  questions, and the gap between them is itself a signal. On the 164x set the
  view-through share ranges from 38% (164d) to 64% (164c), which flips 164c from
  the worst CPA of the four to the best.
- Grouped tiles re-derive rates from summed numerators and denominators, never
  by averaging per-ad percentages.

## The 84 ads we cannot analyse

Four routes were tried and all are dead ends with the current token:

| Route | Result |
|---|---|
| `/{video_id}?fields=source` | `(#10)` — app has no permission on Page-owned videos |
| `/{post_id}?fields=attachments` | `(#100)` Missing permissions |
| `/{ad_id}/previews` iframe | Renders, but client-side; no `<video>` element to scrape |
| Ad number ↔ library video title | Only 2 of 84 — most predate the numbering |
| Thumbnail image fingerprint (`ads-recover-background`) | 22% top-1 accuracy against a labelled set of ads whose answer is known. Refuses to write below 85% |

`ads-recover-background` self-validates before it writes anything, so it is safe
to re-run — it will start applying matches by itself if accuracy ever clears the
bar. **The actual fix is a permission**, not more code: a token with Page access
(`pages_read_engagement`) for the Revive Cafe Page would make
`/{video_id}?fields=source` work for these too.

## Gotchas already paid for

- The Meta account runs on `Etc/GMT+12`, one day behind NZ. Derive the offset
  live; never hardcode it.
- Meta throws two different kinds of error and they need opposite responses.
  "reduce the amount of data" is about payload size — shrink the page. "Service
  temporarily unavailable" and rate-limit errors are about timing — wait and
  retry the same call. `_adsmeta.pageAll` does both. Getting this wrong silently
  dropped a whole insights window mid-backfill and still logged success.
- The `/ads` edge 500s ("reduce the amount of data", or a bare "unknown error")
  once fields × page size gets fat. List light, then fill creative in via
  `?ids=` multi-get. `_adsmeta.pageAll` backs the page size off automatically.
- Adding a schema to `pgrst.db_schemas` is not enough on its own — PostgREST
  also needs `notify pgrst, 'reload schema'` or every read 404s with `PGRST205`.
- `PORTAL_RUN_KEY` is **not currently set** in Netlify, so `ads-audit.js` and
  `meta-config.js` return 403 to everything. The ads functions work around it
  with single-use keys minted into `ads.job`.
