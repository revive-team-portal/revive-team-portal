# My Page — `/me/`

**Purpose:** Staff self-service (PIN login): my training docs and quizzes; entry point for staff-facing features.

**Who uses it:** All staff with a staff PIN.

## Key features
- Home, doc reader, quiz, result

## Data
Reads `training` and `timeclock.staff*` via `me-data`.

## Functions
`staff-auth`, `me-data` (`_staffauth.js`).

## Programming points (keep future changes consistent)
- `_redirects` sends `/me/*` to this page.

## Open items / review notes (Sep 2026)
- Useful only once Training has content.
