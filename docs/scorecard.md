# Scorecard — `/scorecard/`

**Purpose:** Weekly (Fri-ending) business scoreboard: team board for all staff, manager grid, week entry, targets, POS report.

**Who uses it:** Team (public tiles), Supervisor (enter week), Manager (everything) — `user_app_access.role` on app id `scoreboard`.

## Key features
- Team board: 6 tiles, 13-week RAG form guide
- Manager grid, derived metrics, suspect-data muting
- Auto feeds: Shopify, Meta, eShip, TimeKeeper, SwiftPOS (till agent), catering
- Till receipt photo OCR (`scoreboard-receipt`)
- Monthly POS report email

## Data
Schema `scoreboard`: `fact`, `metric`, `metric_target`, `week`, `integration`, `rate_setting`, `tk_job_map`, `order_shipping`, `pos_*`, `app_setting`, (`issue`, `action`, `evidence` — built, never used).

## Functions
`scoreboard-data` (all reads/writes), `scoreboard-receipt`; feeds `shopify-sync`, `meta-sync`, `eship-sync-background`, `timekeeper-sync`, `pos-weekly`, `pos-today-cron`, `pos-agent`.

## Programming points (keep future changes consistent)
- Weeks are ALWAYS Sat–Fri, labelled by Friday, NZ time.
- `quality='suspect'` facts are excluded from averages/RAG.
- Portal app id is `scoreboard`, URL `/scorecard/`.

## Open items / review notes (Sep 2026)
- Issues/actions (accountability list) never used — decide keep or cut.
- `pos_paste` (13.6k agent log rows) and `pos_jobs` (12k) grow forever — add 60-day retention.
