# CID / Little Saigon Public Safety Tracker

Two pieces:

1. **Cloudflare Worker** (`src/worker.js`) — daily cron pulls SPD Crime Data,
   Terry Stops, and Calls-for-Service for beat **K3**, rolls up counts into D1,
   and serves the dashboard page (`/`) plus stored camera images (`/snapshot/<key>`).
2. **GitHub Actions workflow** (`.github/workflows/camera-snapshots.yml`) — grabs
   a still frame from each of the 5 corridor cameras (+ 1 freeway camera) on a
   schedule, uploads to R2, and logs the row straight into the same D1 database.

Camera capture had to move out of the Worker: SDOT's cameras in this corridor
turned out to be live HLS video streams, not static JPGs, and Cloudflare
Workers can't decode video. GitHub's hosted runners have ffmpeg, so that's
where the actual frame-grab happens now.

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

## Still unverified — check before relying on it

1. **Calls-for-Service resource ID** (`worker.js` → `DATASETS.callsForService`,
   currently `33kz-ixgy`). Seattle re-published this dataset with a new
   privacy model; confirm the current 4x4 ID by searching "Call Data" on
   `data.seattle.gov`.
2. **On-view field value** (`worker.js` → `isOnview()`). Pull a few CFS rows
   and check what `initial_call_type` actually says for officer-initiated
   calls, then adjust the string match.
3. Whether beat `K3` is in fact the right/only beat for this corridor — worth
   spot-checking a handful of Terry Stops rows once the pipeline is live.

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

wrangler deploy
```

Test the daily pull without waiting for cron: visit `/run/daily` on your
deployed Worker URL.

### GitHub Actions (camera capture)

Add these repo secrets (Settings → Secrets and variables → Actions):

| Secret | Where to get it |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare dashboard sidebar, or `wrangler whoami` |
| `CF_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens; needs D1 edit permission on the `cid_safety` database |
| `CF_D1_DATABASE_ID` | Same ID you put in `wrangler.toml` |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Cloudflare dashboard → R2 → Manage R2 API Tokens → create a token scoped to the `cid-camera-snapshots` bucket |

Then either wait for the hourly schedule or trigger it manually from the
Actions tab (`workflow_dispatch`).

**Hourly vs. daily**: hourly is what's wired up now. If GitHub Actions
minutes become a concern (only really an issue on a private repo — public
repos get free unlimited minutes), change the cron in
`.github/workflows/camera-snapshots.yml` to `"5 13 * * *"` for once a day,
timed to land right after the Worker's own daily pull.

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
