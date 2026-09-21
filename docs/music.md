# Music — `/music/`

**Purpose:** Public player for 'The Inspiration Project' songs (Suno): shuffle, lock-screen controls, synced lyrics, offline download.

**Who uses it:** Public — no login.

## Key features
- `songs.json` catalogue, art, audio in repo, service worker for offline

## Data
Files in `/music/` (≈75 MB of mp3 in git).

## Functions
None.

## Programming points (keep future changes consistent)
- Adding songs = add mp3/art + entry in `songs.json` from the Suno share link.

## Open items / review notes (Sep 2026)
- Audio in git bloats every clone; move mp3s to Supabase Storage if the catalogue grows past ~30 songs.
