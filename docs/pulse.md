# Pulse — `/pulse/`

**Purpose:** Customer/staff surveys (SurveyMonkey-lite): one-page surveys, collectors (links/QR), responses, reports, prize draws.

**Who uses it:** Admins (0 non-admin grants).

## Key features
- Survey builder, collectors, response reports, AI summary (`pulse-ai`)
- Prize draws from responses
- Email notify per response (`pulse-notify`, called by the Supabase `submit` edge function)

## Data
Schema `pulse`: `surveys`, `questions`, `question_options`, `collectors`, `responses` (1.6k), `answers` (21.6k), `draws`, `settings`, `staff`.

## Functions
`pulse-session`, `pulse-ai`, `pulse-notify` (header key — literal in repo; low risk, rotate with the edge function).

## Programming points (keep future changes consistent)
- LEGACY browser-session pattern.
- Public respondents submit via a Supabase edge function, not this page.

## Open items / review notes (Sep 2026)
- Move `pulse-notify`'s header key to an env var when the edge function is next touched.
