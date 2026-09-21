# Timeclock — `/timeclock/`

**Purpose:** TimeKeeper replacement: phone clock in/out with selfie + GPS (cafe geofence), area at clock-in, breaks, timesheet changes, leave.

**Who uses it:** Staff (PIN via `/me/`-style staff auth) and supervisors.

## Key features
- Clock, timesheet, change requests, leave, who's on, supervisor feed, settings

## Data
Schema `timeclock`: `staff`, `area`, `staff_area`, `punch` (test data only), `change_request`, `leave_request`, `leave_balance`, `setting`, `staff_session`.

## Functions
`timeclock-data`, `staff-admin`, `staff-auth`, `timeclock-cleanup` (nightly).

## Programming points (keep future changes consistent)
- Selfie = human-review photo, NOT face matching (keeps it outside the Biometric Code).
- Leave-pay logic must be rebuilt for the Employment Leave Act by Aug 2028 — keep hours capture separate from pay calc.

## Open items / review notes (Sep 2026)
- Not in live use (12 test punches). Decide go-live date or hide tile.
