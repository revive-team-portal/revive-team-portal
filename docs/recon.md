# Recon — `/recon/`

**Purpose:** Reconcile Shopify payouts and bank deposits against Xero bank statement lines.

**Who uses it:** Admins.

## Key features
- Import bank CSV, pull Xero bank lines, match, run history

## Data
Schema `recon`: `txn` (5.3k), `bank`, `run`, `oauth` (Xero refresh token — shared by every Xero caller).

## Functions
`recon-data` (xero_auth_url, xero_pull, import_bank, sync…); `_xero.js` token row-lock.

## Programming points (keep future changes consistent)
- `recon.oauth` is the single Xero token for the whole portal — never delete or overwrite it.

## Open items / review notes (Sep 2026)
- `bank` empty — feature not yet used end-to-end.
