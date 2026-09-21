# Rostering — `/rostering/`

**Purpose:** Weekly staff roster: shifts by activity, templates, demand, pay totals; published weeks visible to staff.

**Who uses it:** Planners (`is_roster_planner()`), staff read published weeks.

## Key features
- Week grid, copy/paste day, templates
- Activities with colours, demand lines, staff list with rates (hidden by default)
- Publish / draft

## Data
**Portal DB** (not Apps): `roster_weeks`, `roster_shifts`, `roster_staff`, `roster_activities`, `roster_demand`, `roster_templates`. RLS: planners ALL; published rows readable.

## Functions
None — talks to the Portal DB directly.

## Programming points (keep future changes consistent)
- Only app on the Portal DB and the only vanilla-JS app. Builds HTML with template strings and **has no `esc()`** — add one before rendering any new user-typed field.
- 7 unused functions (actHours, addWeek, onRestPointerDown, packColumns, planHours, publishRevision, renderTemplateSel).

## Open items / review notes (Sep 2026)
- Timeclock is meant to replace TimeKeeper; roster + timeclock should share one staff list eventually.
