# Ads — `/ads/`

**Purpose:** Meta ad creative library: every ad with performance, video frames, transcript, vision tags, scores and recommendations.

**Who uses it:** Admins/managers.

## Key features
See `/AGENTS.md` → Ads app (authoritative).

## Data
Schema `ads`: `ad`, `ad_perf`, `ad_tags`, `ad_frame`, `config`, `job` (also holds run keys), `sync_log`. Bucket `ad-frames`.

## Functions
`ads-data`, `ads-run` (page), `ads-sync-background` / `ads-video-background` (workers, internal/run-key), `ads-sync-cron` / `ads-video-cron`, `ads-export`.

## Programming points (keep future changes consistent)
- Purchases always split 1d click / 7d click / 1d view — never blended.
- `bin/` binaries are scoped to the video worker only.

## Open items / review notes (Sep 2026)
- 84 ads unreadable until a token with Page access exists.
