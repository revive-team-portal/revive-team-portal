# Tasks — `/tasks/`

**Purpose:** Management task board: categories, weekly plan, future list, goals, weekly review/check-in.

**Who uses it:** Grant `tasks` (2 users).

## Key features
- Board by category (shareable), week view, future, goals, review

## Data
Schema `tasks`: `task`, `category`, `category_share`, `goal`, `person`, `week_log`, `checkin` (unused).

## Functions
`tasks-data` (actions: bootstrap, save/delete task/category/goal, move/reorder, toggle, save_checkin).

## Programming points (keep future changes consistent)
- Current standard pattern — use as the template for new apps.

## Open items / review notes (Sep 2026)
- Check-ins never used.
