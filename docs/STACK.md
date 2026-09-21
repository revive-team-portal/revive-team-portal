# Portal tech stack — how everything fits (read this first)

Last reviewed: 22 Sep 2026. Rules in `/AGENTS.md` are binding; this file explains the moving parts.
**Never put a secret in this repo** — it is public. Env vars are referenced by NAME only.

## 1. The pieces

| Piece | What / where |
|---|---|
| Site | Netlify site `candid-starlight-7c88d0` → `https://team.revive.co.nz`. Push to `main` = live in ~60 s. No build step. |
| Repo | `revive-team-portal/revive-team-portal` (this). Separate repo `revive-jobs` = public careers site `jobs.revive.co.nz`. |
| Pages | `/<app>/index.html`, one file per app. Vue 3 (global build, CDN) + Tailwind Play CDN + supabase-js v2. Scorecard and Rostering use bespoke CSS. |
| Functions | `netlify/functions/<name>.js` → `/.netlify/functions/<name>`. Node 22, x86_64, 1024 MB, **no package.json** (no npm packages — use `fetch` and Node built-ins). `-background` suffix = up to 15 min, returns 202 immediately. |
| Shared chrome | `/chrome.css` (nav `rv-nav`, green `#16543f`), `/today-bar.js` (green status bar), `/assets/*`. Change look in one place. |
| Portal DB | Supabase **Revive Portal** `zpcbtfdjcsbdeqnizrpr`: `profiles`, `apps` (tiles), `user_app_access` (who sees what, optional `role`), `gmail_tokens`, `roster_*` (Rostering). |
| Apps DB | Supabase **Revive Apps** `xcwrawjdfajlmbkdwlbm`: one Postgres schema per app (`recipes, sales, support, production, pulse, scoreboard, jobs, tasks, timeclock, checklist, training, recon, ads`). `zz_archive` = retired tables (not exposed). `private` = internal helpers (not exposed). |

## 2. Keys (env vars in Netlify — values never in the repo)

| Env var | Used for |
|---|---|
| `PORTAL_SERVICE_ROLE_KEY`, `APPS_SERVICE_ROLE_KEY` | Server-side DB access (bypasses RLS). Also seeds the internal-call token. |
| `ANTHROPIC_API_KEY` | All AI calls (via functions only — never the browser). Models in use: `claude-sonnet-4-6` (vision/OCR, drafting), `claude-haiku-4-5-20251001` (cheap analysis). |
| `SHOPIFY_CLIENT_ID/SECRET`, `SHOPIFY_STORE_DOMAIN` | "Revive Cafe Support" Shopify app, revive.co.nz. Read orders/customers/journeys; **cannot write products**. Helper `_shopify.js`. |
| `META_ACCESS_TOKEN` | Meta Marketing API, `ads_read` only, never expires. Ad account `act_242089740673955`, tz `Etc/GMT+12` (one day behind NZ — derive, never hardcode). |
| `XERO_CLIENT_ID/SECRET` | "Revive Team Portal" Xero app, authorised on BOTH Revive Cafes Ltd and Revivealicious Foods Ltd. Rotating refresh token lives in `recon.oauth` (row-locked). Helper `_xero.js`. |
| `ESHIP_API_KEY`, `ESHIP_SUBSCRIPTION_KEY` | NZ Post eShip = white-label Starshipit (`api.starshipit.com`). Helper `_eship.js`. |
| `GMAIL_CLIENT_ID/SECRET` | Gmail OAuth for Sales (shared mailbox) and Support (cafe@). Tokens in portal `gmail_tokens`. |
| `TIMEKEEPER_API_KEY` | TimeKeeper (admin-equivalent key — GET only, whitelisted paths). Helper `_tksync.js`. |
| `RESEND_KEY`, `RESEND_FROM` | Outbound email (`_mail.js`), Gmail fallback + alert if Resend fails. |
| `OPENAI_ADS_API_KEY` | OpenAI Ads API (temp functions only). |
| `POS_AGENT_KEY` | Till-PC agent guard (falls back to a legacy literal — rotate at the till, see REVIEW). |
| `SALES_APP_PASSWORD`, `RECIPES_APP_PASSWORD`, `PULSE_APP_PASSWORD` | Shared service-account logins for the older browser-session apps. |
| `PORTAL_RUN_KEY` | Optional, **currently unset**. Not needed — use single-use run keys. |

Adding an env var needs Jeremy to set it in Netlify once. Avoid it if an existing key or a DB-stored value will do.

## 3. The three ways a function is protected — pick exactly one

| Caller | Guard | Code |
|---|---|---|
| A logged-in person in a portal page | `validatePortalUser(event, '<app_id>')` (pass `null` = any active user) | `const { json, validatePortalUser } = require('./_portal')` |
| Our own function (cron → background worker) | internal header | caller: `require('./_runkey').internalFetch('worker-background?x=1')` · worker: `if (!(await guard(event)).ok) return DENY` |
| Claude / a maintenance run | single-use run key `?k=` | same `guard(event)` |
| Staff PIN pages (`/me/`, Timeclock kiosk) | `_staffauth.js` sessions | `require('./_staffauth')` |

**Minting a run key** (Supabase, Revive Apps): 
```sql
INSERT INTO ads.job (kind,status,cursor,note) VALUES ('runkey','open',encode(gen_random_bytes(18),'hex'),'<why>') RETURNING cursor;
```
Valid 30 min, burns on first use, one per call.

Scheduled functions (`schedule =` in `netlify.toml`) cannot be called over HTTP — so the schedule sits on a thin `*-cron` trigger that `internalFetch`es the worker. **Never put a schedule on a `-background` function.**

## 4. Claude's tools (all `?k=<run key>`)

| Endpoint | Returns |
|---|---|
| `ads-audit?start=&end=` | Per-NZ-day Shopify orders/sales joined to Meta spend, campaign detail, raw orders with UTMs |
| `ads-export?state=&media=&brand=&since=` | Tagged ad-creative corpus (see AGENTS.md → Ads) |
| `meta-config` | Account status + every campaign/ad set budget, bid, schedule |
| `xero-query?org=foods\|cafes&path=/api.xro/2.0/<Resource>&where=&pages=all` | Any Xero GET, either company. `?org=list`, `?connect=1` (fresh consent link if `invalid_grant`) |
| `tk-daily?start=&end=&job_id=` | TimeKeeper per-NZ-day hours + people |
| `shopify-probe` | Granted Shopify scopes + readable order fields |
| `shopify-run` / `meta-run` / `eship-run` / `tk-run` | Manual re-sync into the scorecard (`start/end` or `since/max`) |
| `catering-sync-background?start=&end=` | Catering backfill |
| `support-customer-enrich-background` | Refresh Support customer profiles from Shopify |

For a one-off query nothing covers: add a small read-only function using `guard`, push, call, delete, push.

## 5. Browser data access — two patterns exist

- **Current standard (use for all new apps):** RLS on, **no policies**, schema not granted to `anon`/`authenticated`. Browser calls one `<app>-data.js` function with an `action`. Examples: Scorecard, Tasks, Checklist, Training, Timeclock, Recon, Ads, Support.
- **Legacy (Recipes, Sales, Pulse, Production browser reads):** `<app>-session.js` signs the browser into a shared service account on Revive Apps; policies are `USING (true)` for `authenticated`. Safe only because self-signup is blocked by the `private.block_unlisted_signup` trigger. **New app service accounts must be added to `private.signup_allow` first.**
- **Jobs:** documented exception (public form reads/writes as `anon`). Don't change grants casually.

## 6. New schema checklist
1. Migration (not ad-hoc SQL): create schema + tables, `enable row level security` on every table, `grant usage ... to service_role`.
2. Expose it: **read** `select rolconfig from pg_roles where rolname='authenticator'`, append yours, `notify pgrst, 'reload config'; notify pgrst, 'reload schema';`
3. Verify every other app's schema still answers (a `PGRST205` is fine, `PGRST106` = you dropped one).

## 7. New app checklist
1. `/<app>/index.html` — copy the header/loading/gate block from `tasks/index.html` (current standard). Include `/chrome.css` and `/today-bar.js`.
2. `netlify/functions/<app>-data.js` — `validatePortalUser(event,'<app>')` first, then `switch(action)`.
3. Portal DB: `insert into apps (id,name,url,status,sort_order,…)` — one-word name. Admins see it at once; others need `user_app_access`.
4. `docs/<app>.md` from `docs/_TEMPLATE.md`, and a line in `docs/README.md`.
5. Deploy procedure in AGENTS.md §2/§8: fresh clone, `node --check`, push, verify live, exercise the real path.

## 8. Health checks
- Crons ran? `select kind, ok, created_at from ads.sync_log order by created_at desc limit 5;` · `select * from support.sync_status;` · `select updated_at from scoreboard.pos_today;` · `select status, note, updated_at from sales.xero_sync;`
- Supabase security advisor: expect only "RLS enabled, no policy" (intended) + leaked-password notice until turned on.
