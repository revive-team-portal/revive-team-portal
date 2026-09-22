# Support — `/support/`

**Purpose:** Customer-service ticketing for cafe@ Gmail: tickets per customer with Shopify orders, NZ Post tracking, AI drafts, claims, naughty (problem-shipment) list, testimonials.

**Who uses it:** CS team + admins (grant `support`).

## Key features
- Inbox sync every 5 min into tickets/messages; spam rescue hourly; holding reply for tickets past SLA
- Customer panel: Shopify orders, lifetime value, tracking (eShip)
- AI draft/polish replies, reason codes, resolve with code
- NZ Post claims + GST invoice, naughty-order courier scan (daily), replacement orders, stock set/restock
- Analytics, reports, benchmark, testimonials

## Data
Schema `support`: `tickets`, `messages`, `customers`, `notes`, `interactions`, `claims`, `naughty_orders`, `naughty_scan`, `nzpost_codes`, `reason_codes`, `settings`, `sync_status`, `testimonials`, `orders` (empty; kept as FK anchor). Retired to `zz_archive`: best_answers, exceptions, message_embeddings, order_line_items, tracking_events.

## Functions
~45 `support-*` functions, all `validatePortalUser(event,'support')`. Engines: `_ingest`, `_spamcheck`, `_holdingreply`, `_naughtyscan`, `_nzpostalert`, `_nzpostdelay`, `_gmail`, `_eship`, `_shopify`.

## Programming points (keep future changes consistent)
- Fully server-side (current standard). One function per action — fine, but new work should add actions to an existing function rather than new files.
- Raw `innerHTML` rendering: always `esc()` (it escapes quotes) for email text, names, filenames.

## Open items / review notes (Sep 2026)
- DONE 22 Sep 2026: `scheduled-sync` now skips threads whose Gmail `historyId` equals `tickets.gmail_history_id` (one `threads.list` call per run). `sync_status.result` shows `processed` vs `skipped`. Pass `force:true` to `support-ingest` for a full re-read.
