# Jobs — `/jobs/`

**Purpose:** Recruitment admin for jobs.revive.co.nz: job ads, applicants with AI Fit/Human scores, interview slots, connections.

**Who uses it:** Grant `jobs` (3).

## Key features
- Applicant tiles (3 columns: info / own words / scores+notes+docs)
- Job edit + AI ad text, interview booking, gallery

## Data
Schema `jobs` (browser + public anon access — documented exception).

## Functions
Mostly in the **revive-jobs** repo (`analyse-application`, `send-email`, `job-ad-text`); `portal-validate` here.

## Programming points (keep future changes consistent)
- A change often needs BOTH repos. Don't revoke anon grants (public form breaks).

## Open items / review notes (Sep 2026)
- Largest page (186 KB).
