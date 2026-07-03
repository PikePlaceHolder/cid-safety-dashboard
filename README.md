# CID / Little Saigon Public Safety Tracker

Two pieces:

1. **Cloudflare Worker** (`src/worker.js`) — daily cron pulls SPD Crime Data,
   Terry Stops, and Calls-for-Service for beat **K3**, rolls up counts into D1,
   and serves the dashboard page (`/`) plus stored camera images (`/snapshot/<key>`).
2. **GitHub Actions workflow** (`.github/workflows/camera-snapshots.yml`) — grabs
   a still frame from each of the 5 corridor cameras (+ 1 freeway camera),
   uploads to R2, and logs the row straight into the same D1 database.

Camera capture had to move out of the Worker: SDOT's cameras in this corridor
turned out to be live HLS video streams, not static JPGs, and Cloudflare
Workers can't decode video. GitHub's hosted runners have ffmpeg, so that's
where the actual frame-grab happens now.

**Scheduling the camera capture turned out to be its own problem.** GitHub's
native `schedule:` trigger on this workflow proved unreliable — confirmed via
direct testing that ticks silently no-showed for hours, including a same-day
near-future test cron that never fired at all (no GitHub status incident at
the time). Rather than depend on that, the Worker's own cron (proven
reliable — it's been firing the daily data pull exactly on schedule) now
dispatches the camera-capture workflow via GitHub's API every 3 hours,
using a fine-grained PAT (`GITHUB_PAT` Worker secret, `Actions: read/write`
scoped to just this repo). The workflow's own `schedule:` trigger is left in
place as a harmless backup in case GitHub's scheduler ever does pick this
repo up — worst case is an occasional extra capture, not a conflict.

## Confirmed facts (as of this build)

- **Beat, not MCPP.** The SPD Crime Data feed no longer publishes an MCPP
  value for the CID — you found it blank on the live map, and I've moved all
  three datasets (crime, Terry Stops, CFS) onto a single beat filter,
  currently `K3` (`wrangler.toml` → `CID_BEATS`).
- **Camera identities**, pulled from SDOT's own internal API
  (`https://web.seattle.gov/Travelers/api/Map/Data?zoomId=18&type=2`):

  | Location | Camera ID | Type |
  |---|---|---|
  | 5th Ave S & S Jackson St | CMR-0428 | SDOT (HLS) |
  | S Jackson St & Maynard Ave S | CMR-0306 | SDOT (HLS) |
  | 12th Ave S & S Jackson St | CMR-0193 | SDOT (HLS) |
  | 5th Ave S / S Dearborn St | CMR-0053 | SDOT (HLS) |
  | 4th Ave S & S Weller St | CMR-0427 | SDOT (HLS) |
  | I-5 @ Yesler St | I5Yesler | WSDOT (static JPG) |

  The I-5/Yesler camera is the nearest freeway-adjacent option; it's a couple
  blocks north of Dearborn/Weller rather than directly overhead, since that's
  what SDOT/WSDOT actually have online right now.
- **Stream mechanism**: SDOT cameras are served off a Wowza server at
  `61e0c5d388c2e.streamlock.net`, one HLS playlist per camera
  (`/live/{slug}.stream/playlist.m3u8`). This is reverse-engineered from a
  third-party open-source viewer, not official SDOT documentation — if
  captures start failing, that hostname is the first thing to check (see the
  comment at the top of `scripts/capture-snapshots.sh` for how to re-derive it).

## Confirmed against live data (2026-07)

Deploying and running `/run/daily` against the real Socrata endpoints turned
up several column renames Seattle made since this project was scaffolded —
all now fixed in `worker.js`:

- **Calls-for-Service resource ID `33kz-ixgy` is still valid** — the dataset
  wasn't republished under a new ID, but several columns were renamed:
  `beat` → `dispatch_beat`, `precinct` → `dispatch_precinct`,
  `original_time_queued` → `cad_event_original_time_queued`.
- **Crime dataset** date column is `offense_date`, not `occurred_date`; there's
  no `offense` column, so the offense description now comes from
  `nibrs_offense_code_description` (falling back to `offense_sub_category`).
- **Terry Stops** date column is `occurred_date`, not `stop_date`.
- **On-view detection confirmed**: CFS rows have a purpose-built
  `call_type_indicator` field that reads exactly `"ONVIEW"` for
  officer-initiated calls — `isOnview()` now checks that first, falling back
  to the original substring match on `initial_call_type` as a safety net.
- **Beat `K3` is correct and has real, recent CID/Little Saigon activity** —
  confirmed via live query (51k+ historical crime records, current data).
- **Publishing lag**: all three datasets lag several days behind real-time
  (crime/Terry Stops ~3 days, CFS up to ~5 days as observed). The pull window
  was widened from 2 to 7 days to reliably catch data that's landed since the
  last run; `ON CONFLICT DO NOTHING` on insert makes the overlap harmless.

## Still worth double-checking periodically

Seattle's open data portal has changed column names on all three datasets at
least once already — if `/run/daily` starts silently returning zero counts
again (check via the JSON response, or `wrangler tail`), re-run the manual
`Invoke-WebRequest`/`curl` checks against the raw Socrata endpoints described
above before assuming the beat filter or pipeline logic is at fault.

## Setup

### Worker (Cloudflare)

```bash
npm install -g wrangler
wrangler login

wrangler d1 create cid_safety            # paste the returned database_id into wrangler.toml
wrangler d1 execute cid_safety --file=schema.sql

wrangler r2 bucket create cid-camera-snapshots

# optional but recommended, avoids Socrata throttling:
# https://data.seattle.gov/profile/edit/developer_settings
wrangler secret put SOCRATA_APP_TOKEN

# needed so the Worker's cron can dispatch the camera-capture workflow
# (see "Camera capture scheduling" below for how to create this token)
wrangler secret put GITHUB_PAT

wrangler deploy
```

Test the daily pull without waiting for cron: visit `/run/daily` on your
deployed Worker URL. Test the camera-capture dispatch the same way: visit
`/run/camera-dispatch`.

### GitHub Actions (camera capture)

Add these repo secrets (Settings → Secrets and variables → Actions):

| Secret | Where to get it |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare dashboard sidebar, or `wrangler whoami` |
| `CF_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens; needs D1 edit permission on the `cid_safety` database |
| `CF_D1_DATABASE_ID` | Same ID you put in `wrangler.toml` |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Cloudflare dashboard → R2 → Manage R2 API Tokens → create a token scoped to the `cid-camera-snapshots` bucket |

### Camera capture scheduling

The workflow only runs via `workflow_dispatch` in practice — see the note
above about GitHub's native `schedule:` trigger being unreliable for this
repo. The Worker dispatches it instead:

1. Create a fine-grained GitHub PAT at
   [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new),
   scoped to **only this repository**, with **Actions: Read and write**
   permission and nothing else.
2. `wrangler secret put GITHUB_PAT` on the Worker (see above).
3. The Worker's second cron trigger (`wrangler.toml` → `[triggers].crons`)
   calls GitHub's dispatch API on the same 3-hour cadence.

**3-hourly vs. daily**: every 3 hours (8 runs/day/camera), anchored to
Seattle midnight, is what's wired up now — see the comment above the cron
line in `.github/workflows/camera-snapshots.yml` for the UTC/DST math. If
GitHub Actions minutes become a concern (only really an issue on a private
repo — public repos get free unlimited minutes), change the cron to
`"0 13 * * *"` for once a day, timed to land right after the Worker's own
daily pull.

## On the promise-tracker problem

Wilson's CID-specific commitments are process promises ("more contact, fewer
arrests," "restore late-night presence") rather than numeric targets, so
there's nothing to hold her to a number on. The three-line trend chart (crime
reports, Terry stops, CFS on-views) is built around the closest quantifiable
signature of that policy actually happening — contact rising without a
matching rise in crime or (as far as public data allows) arrests — with the
two promise dates as reference points.

Two things this still can't show:
- **Arrests**: not published at the individual level in any current SPD dataset.
- **City Attorney case outcomes**: not tracked/published anywhere I could
  find — matches what you already suspected.

Happy to add a manual notes table to the dashboard for logging those
qualitatively (news reports, court dates, etc.) alongside the automated
metrics, since neither gap is solvable with an API.
