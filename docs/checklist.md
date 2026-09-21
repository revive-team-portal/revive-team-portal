# Checklist — `/checklist/`

**Purpose:** Cafe food-safety & opening/closing routines: timed task blocks, temperature readings, corrective actions, waste log, shift handover.

**Who uses it:** Grant `checklist` (3). `admin.html` = routine setup, `manager.html` = dashboard.

## Key features
- Today view by block, complete/uncomplete, flags
- Temps with corrective actions, waste log, handover

## Data
Schema `checklist`: `routines`, `tasks`, `assignments`, `completions`, `temp_readings`, `corrective_actions`, `units`, `waste_items`, `waste_log`, `handover`, `flags`, `photos`, `staff`.

## Functions
`checklist` (single action function).

## Programming points (keep future changes consistent)
- Current standard pattern. Three pages share one function.

## Open items / review notes (Sep 2026)
- Light use so far (27 completions). Waste log, handover and photos never used.
