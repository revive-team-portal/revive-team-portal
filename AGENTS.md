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
- **RLS stays on** for every table, with **no** `anon`/`authenticated` policies. The browser reads nothing directly; everything goes through a function on the service‑role key. New schema? Add it to the exposed‑schemas list on Revive Apps (see skill).
- **Escape all DB/user text before putting it in HTML.** Vue `{{ }}` is safe; raw `innerHTML`/template strings are not. The `esc()` helper **must** escape `& < > " '` (quotes included). This applies especially to anything from outside parties (email content, attachment filenames, customer names).
- Don't expose business financials or PII on unauthenticated endpoints or with `Access‑Control‑Allow‑Origin: *`.

## 6. Correctness rules (caught real bugs)

- **Dates are NZ.** Default any date to NZ (`Pacific/Auckland`), never `new Date().toISOString().slice(0,10)` (that's UTC → shows "yesterday" all NZ morning).
- **Declare every Vue `ref()` you use.** Two apps shipped a blank screen from an undeclared ref. A quick `node`/lint pass or grep for `.value` on undeclared names catches it.
- **On edit, load everything you'll save.** Don't delete‑then‑reinsert from a partially‑loaded object (this wiped recipe steps).
- **Handle query errors.** Check Supabase `error` on every call; show a retry state, not a silent empty screen. Add fetch timeouts so a hung request doesn't spin forever.
- **Mobile:** provide a touch path for anything drag‑and‑drop; no fixed widths that overflow phones; tap targets ≥ ~40px.

## 7. Two Supabase projects — pick the right one

- **Revive Portal** (`zpcbtfdjcsbdeqnizrpr`): logins, `profiles`, `apps`, `user_app_access` (role gating).
- **Revive Apps** (`xcwrawjdfajlmbkdwlbm`): the app data (recipes, sales, support, production, pulse, scoreboard, tasks…).
- Functions use the service‑role keys (`PORTAL_SERVICE_ROLE_KEY`, `APPS_SERVICE_ROLE_KEY`), which bypass RLS.

## 8. Before you call a change "done"

`node --check` passed · helper requires exist · deployed to `main` · **verified live** (served string + function status) · no secret added · DB text escaped · dates are NZ · looks right on mobile. Report URL + commit hash.
