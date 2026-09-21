# Sales — `/sales/`

**Purpose:** Revivealicious wholesale CRM: stores/buyers, activity log, Gmail send/read from the shared mailbox, Xero wholesale sales roll-up per store.

**Who uses it:** Sales team + admins (grant `sales`).

## Key features
- Store list with type, rating (5-star = keen), contacts, PO email
- Activity timeline, email templates, documents, motivation quotes
- Gmail inbox/read/send/file (shared mailbox)
- Daily Xero sync of wholesale invoices into `xero_orders` (Revivealicious, cartons of 6: items 101/102/103)
- AI assist (`sales-ai`)

## Data
Schema `sales`: `stores`, `activities`, `documents`, `email_templates`, `motivation`, `settings`, `xero_orders`, `xero_sync`.

## Functions
`sales-session`, `sales-ai`, `sales-xero-refresh` → `sales-xero-sync-background` (internal), cron `sales-xero-cron` 06:45 NZ; `gmail-*`.

## Programming points (keep future changes consistent)
- 100 commits, the most-changed app. Lost features TWICE to stale deploys — always edit a fresh clone, never paste an older file over `main`.
- LEGACY browser-session pattern (as Recipes).
- Xero goes through `_xero.js` / `_xerosales.js` only.

## Open items / review notes (Sep 2026)
- Largest single file (~170 KB). Next big change: split Gmail and Xero panels into their own functions/actions before adding features.
