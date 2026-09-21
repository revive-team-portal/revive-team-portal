# Production — `/production/`

**Purpose:** Wopples production tracking: shift records from the CHK001 checksheet (scan + OCR), versioned costed recipes, planning calendar, NPD, nutrition.

**Who uses it:** Operators (capture, records) and Supervisors (costs, recipes, settings) — `user_app_access.role`. Admin = supervisor.

## Key features
- Records table + run detail (utilisation, AI commentary, photos, verification ticks)
- Capture: iPhone scan → Sonnet OCR → review → save; finished/kitchen/waste photos
- Recipes: current version per flavour, print sheet, edit → new version or in-place fix, history
- Planning: week-per-row calendar, tap-to-place
- Settings: ingredient $/kg, labour/pack/power rates, weekly pack estimates
- NPD projects + nutrition panels

## Data
Schema `production`: `production_run` (cost computed by DB trigger `compute_run_cost`), `run_photo` (bucket `production-photos`), `recipe` (+`short_code`, `is_current`, `active`), `recipe_ingredient`, `ingredient_cost`, `ingredient_nutrition`, `rate_setting`, `production_plan`, `audit_log`, `npd_*`.

## Functions
`production-session` (shared account), `production-data` (supervisor actions), `production-ai` (OCR `claude-sonnet-4-6`, analysis Haiku), `npd-data`.

## Programming points (keep future changes consistent)
- Costs display to 3 dp via `money()`; batches/hours/g-per-waffle 1 dp; grams whole.
- Operators must never receive pricing: pricing reads go through `production-data` role checks, not the browser.
- 136 runs imported from WhatsApp (`verification.source='whatsapp_import*'`, `needs_review` flag).

## Open items / review notes (Sep 2026)
- Browser still writes runs directly (legacy). Move capture writes into `production-data`.
- Add a 'needs review' filter to Records (50 imported runs flagged).
