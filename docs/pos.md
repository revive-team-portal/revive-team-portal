# POS setup — `/pos/`

**Purpose:** Setup/diagnostics page for the SwiftPOS till-PC agent that feeds cafe sales into the Scorecard.

**Who uses it:** Admin at the till PC.

## Key features
- Install script, paste box for query output

## Data
`scoreboard.pos_jobs`, `pos_paste`, `pos_today`, `pos_dept_week`.

## Functions
`pos-agent` (key-guarded), `pos-paste` (unguarded log sink).

## Programming points (keep future changes consistent)
- Agent only runs SELECTs queued by us.

## Open items / review notes (Sep 2026)
- Agent key is a literal in the public repo — rotate next time someone is at the till.
