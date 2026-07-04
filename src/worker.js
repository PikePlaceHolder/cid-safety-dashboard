/**
 * CID Safety Dashboard — Cloudflare Worker
 *
 * Two jobs, run on cron:
 *   1. Daily: pull SPD Crime Data + Terry Stops + Calls-for-Service, roll up counts.
 *   2. Hourly: grab a still frame from each configured traffic camera and store it
 *      in R2, since SDOT does not archive camera images itself.
 *
 * Also serves a small dashboard page at "/" reading from D1, and raw snapshot
 * images at "/snapshot/<r2_key>".
 *
 * KNOWN UNVERIFIED SPOTS (search the file for "TODO verify"):
 *   - Exact MCPP string for the CID in the crime dataset
 *   - Beat codes covering 12th & Jackson / Little Saigon
 *   - The row-level Calls-for-Service resource ID (Seattle's open data portal
 *     re-published this dataset with a new privacy model; grab the current 4x4
 *     ID from data.seattle.gov by searching "Call Data" before wiring this up)
 *   - CAMERAS list — fill in with URLs/coordinates you've confirmed on
 *     https://web5.seattle.gov/travelers/
 */

// ---- Static config -------------------------------------------------------

const SOCRATA_DOMAIN = "data.seattle.gov"; // cos-data.seattle.gov also resolves the same IDs

const GITHUB_REPO = "PikePlaceHolder/cid-safety-dashboard";
const GITHUB_CAMERA_WORKFLOW = "camera-snapshots.yml";

const DATASETS = {
  // SPD Crime Data, 2008-present. Confirmed current as of this build.
  crime: "tazs-3rd5",
  // Terry Stops (officer-initiated investigative stops). Confirmed current.
  terryStops: "28ny-9ts8",
  // TODO verify: row-level Calls for Service. Placeholder — confirm on
  // data.seattle.gov before relying on this in production.
  callsForService: "33kz-ixgy",
};

// Camera identity/coordinates now live in cameras.json (used by the GitHub
// Actions capture workflow). SDOT's five cameras in this corridor are live
// HLS video streams, not static JPGs, so Workers can't grab frames from them
// directly — see .github/workflows/camera-snapshots.yml and scripts/capture-snapshots.sh.

// ---- Helpers ---------------------------------------------------------------

function socrataUrl(datasetId, params) {
  const url = new URL(`https://${SOCRATA_DOMAIN}/resource/${datasetId}.json`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function socrataFetch(datasetId, params, env) {
  const url = socrataUrl(datasetId, params);
  const headers = {};
  if (env.SOCRATA_APP_TOKEN) headers["X-App-Token"] = env.SOCRATA_APP_TOKEN;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Socrata fetch failed (${res.status}) for ${datasetId}: ${await res.text()}`);
  }
  return res.json();
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function isOnview(callTypeIndicator, initialCallType) {
  // Confirmed against live data: call_type_indicator is "ONVIEW" for
  // officer-initiated calls. Falls back to substring match on
  // initial_call_type in case call_type_indicator is ever blank.
  if (callTypeIndicator && callTypeIndicator.toUpperCase() === "ONVIEW") return true;
  if (!initialCallType) return false;
  const t = initialCallType.toUpperCase();
  return t.includes("ONVIEW") || t.includes("ON VIEW") || t.includes("PROACTIVE");
}

// ---- Daily pull: crime + Terry stops + CFS ---------------------------------

async function pullCrimeData(env, sinceDate) {
  // Crime dataset dropped MCPP from its published fields — beat is now the
  // only reliable geography filter across all three SPD datasets.
  const beats = (env.CID_BEATS || "").split(",").map((b) => b.trim()).filter(Boolean);
  if (!beats.length) return 0;
  const beatClause = beats.map((b) => `'${b}'`).join(",");
  const since = sinceDate ?? daysAgoISO(7);

  let rows;
  try {
    rows = await socrataFetch(
      DATASETS.crime,
      {
        // TODO verify: confirmed live 2026-07 that this dataset's date
        // column is "offense_date", not "occurred_date" as originally
        // scaffolded.
        "$where": `beat in (${beatClause}) AND offense_date > '${since}'`,
        "$limit": "5000",
      },
      env
    );
  } catch (e) {
    console.error("Crime data pull failed, check DATASETS.crime columns:", e.message);
    return 0;
  }

  const stmts = rows.map((r) =>
    env.DB.prepare(
      `INSERT INTO crime_events (report_number, offense, offense_category, occurred_date, mcpp, precinct, sector, beat, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(report_number) DO NOTHING`
    ).bind(
      r.report_number ?? r.offense_id ?? crypto.randomUUID(),
      r.nibrs_offense_code_description ?? r.offense_sub_category ?? null,
      r.offense_category ?? null,
      r.offense_date ?? null,
      r.mcpp ?? null,
      r.precinct ?? null,
      r.sector ?? null,
      r.beat ?? null,
      new Date().toISOString()
    )
  );
  if (stmts.length) await env.DB.batch(stmts);
  return rows.length;
}

async function pullTerryStops(env, sinceDate) {
  const beats = (env.CID_BEATS || "").split(",").map((b) => b.trim()).filter(Boolean);
  if (!beats.length) return 0;

  const beatClause = beats.map((b) => `'${b}'`).join(",");
  const since = sinceDate ?? daysAgoISO(7);
  let rows;
  try {
    rows = await socrataFetch(
      DATASETS.terryStops,
      {
        // TODO verify: confirmed live 2026-07 that this dataset's date
        // column is "occurred_date", not "stop_date" as originally
        // scaffolded.
        "$where": `beat in (${beatClause}) AND occurred_date > '${since}'`,
        "$limit": "5000",
      },
      env
    );
  } catch (e) {
    console.error("Terry Stops pull failed, check DATASETS.terryStops columns:", e.message);
    return 0;
  }

  const stmts = rows.map((r) =>
    env.DB.prepare(
      `INSERT INTO terry_stops (stop_id, stop_date, precinct, sector, beat, stop_resolution, initial_call_type, final_call_type, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(stop_id) DO NOTHING`
    ).bind(
      r.terry_stop_id ?? crypto.randomUUID(),
      r.occurred_date ?? r.reported_date ?? null,
      r.precinct ?? null,
      r.sector ?? null,
      r.beat ?? null,
      r.stop_resolution ?? null,
      r.initial_call_type ?? null,
      r.final_call_type ?? null,
      new Date().toISOString()
    )
  );
  if (stmts.length) await env.DB.batch(stmts);
  return rows.length;
}

async function pullCallsForService(env, sinceDate) {
  const beats = (env.CID_BEATS || "").split(",").map((b) => b.trim()).filter(Boolean);
  if (!beats.length) return 0;

  const beatClause = beats.map((b) => `'${b}'`).join(",");
  const since = sinceDate ?? daysAgoISO(7);
  let rows;
  try {
    // TODO verify: confirmed live 2026-07 that resource ID 33kz-ixgy is
    // still valid, but Seattle renamed several columns (privacy-model
    // republish) — beat -> dispatch_beat, original_time_queued ->
    // cad_event_original_time_queued.
    rows = await socrataFetch(
      DATASETS.callsForService,
      {
        "$where": `dispatch_beat in (${beatClause}) AND cad_event_original_time_queued > '${since}'`,
        "$limit": "5000",
      },
      env
    );
  } catch (e) {
    // Resource ID likely stale — see TODO verify note at top of file.
    console.error("Calls-for-Service pull failed, check DATASETS.callsForService id:", e.message);
    return 0;
  }

  const stmts = rows.map((r) =>
    env.DB.prepare(
      `INSERT INTO calls_for_service (cad_event_number, call_date, initial_call_type, final_call_type, beat, precinct, officer_initiated, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cad_event_number) DO NOTHING`
    ).bind(
      r.cad_event_number ?? r.cad_cdw_id ?? crypto.randomUUID(),
      r.cad_event_original_time_queued ?? null,
      r.initial_call_type ?? null,
      r.final_call_type ?? null,
      r.dispatch_beat ?? null,
      r.dispatch_precinct ?? null,
      isOnview(r.call_type_indicator, r.initial_call_type) ? 1 : 0,
      new Date().toISOString()
    )
  );
  if (stmts.length) await env.DB.batch(stmts);
  return rows.length;
}

// GitHub's own `schedule:` trigger proved unreliable for the camera-capture
// workflow (confirmed by direct testing — ticks silently no-showed for
// hours). This Worker's cron dispatches it via the API instead, using a
// fine-grained PAT (Actions: read/write on this repo only) stored as the
// GITHUB_PAT secret.
async function dispatchCameraCapture(env) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_CAMERA_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GITHUB_PAT}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "cid-safety-dashboard-worker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    }
  );
  if (!res.ok) {
    console.error(`GitHub workflow dispatch failed (${res.status}): ${await res.text()}`);
  }
  return res.ok;
}

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function daysBeforeISO(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Weekly buckets run Thursday->Wednesday so that PROMISE_2_DATE (June 18,
// 2026 — a Thursday) always lands as the first day of its week.
function weekStartISO(dayISO) {
  const d = new Date(`${dayISO}T00:00:00Z`);
  const offsetFromThursday = (d.getUTCDay() - 4 + 7) % 7;
  d.setUTCDate(d.getUTCDate() - offsetFromThursday);
  return d.toISOString().slice(0, 10);
}

function aggregateWeekly(rows) {
  const byWeek = new Map();
  for (const r of rows) {
    const wk = weekStartISO(r.day);
    if (!byWeek.has(wk)) {
      byWeek.set(wk, { day: wk, crime_count: 0, terry_stop_count: 0, cfs_total: 0, cfs_onview: 0 });
    }
    const agg = byWeek.get(wk);
    agg.crime_count += r.crime_count ?? 0;
    agg.terry_stop_count += r.terry_stop_count ?? 0;
    agg.cfs_total += r.cfs_total ?? 0;
    agg.cfs_onview += r.cfs_onview ?? 0;
  }
  return [...byWeek.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function buildChartSeries(rows) {
  return {
    labels: rows.map((r) => r.day),
    crime: rows.map((r) => r.crime_count),
    terry: rows.map((r) => r.terry_stop_count),
    cfsOnview: rows.map((r) => r.cfs_onview),
    cfsOther: rows.map((r) => (r.cfs_total ?? 0) - (r.cfs_onview ?? 0)),
    // Ratios as percentages; null (not 0) on days/weeks with no denominator
    // so Chart.js leaves a gap instead of plotting a misleading 0.
    terryPerCrime: rows.map((r) =>
      r.crime_count > 0 ? Math.round((r.terry_stop_count / r.crime_count) * 1000) / 10 : null
    ),
    onviewShare: rows.map((r) =>
      r.cfs_total > 0 ? Math.round((r.cfs_onview / r.cfs_total) * 1000) / 10 : null
    ),
  };
}

async function rollupDaily(env) {
  // All three SPD datasets lag several days behind real-time (see README),
  // so rolling up only "today" would always show zero. Instead, roll up
  // every distinct day actually present across the three tables.
  const daysResult = await env.DB.prepare(
    `SELECT DISTINCT day FROM (
       SELECT substr(occurred_date, 1, 10) AS day FROM crime_events
       UNION
       SELECT substr(stop_date, 1, 10) AS day FROM terry_stops
       UNION
       SELECT substr(call_date, 1, 10) AS day FROM calls_for_service
     ) WHERE day IS NOT NULL AND day != ''`
  ).all();

  const validDays = (daysResult.results ?? []).map((r) => r.day);

  for (const day of validDays) {
    const crime = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM crime_events WHERE occurred_date LIKE ?`
    ).bind(`${day}%`).first();
    const terry = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM terry_stops WHERE stop_date LIKE ?`
    ).bind(`${day}%`).first();
    const cfsTotal = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM calls_for_service WHERE call_date LIKE ?`
    ).bind(`${day}%`).first();
    const cfsOnview = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM calls_for_service WHERE call_date LIKE ? AND officer_initiated = 1`
    ).bind(`${day}%`).first();

    await env.DB.prepare(
      `INSERT INTO daily_rollup (day, crime_count, terry_stop_count, cfs_total, cfs_onview)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         crime_count = excluded.crime_count,
         terry_stop_count = excluded.terry_stop_count,
         cfs_total = excluded.cfs_total,
         cfs_onview = excluded.cfs_onview`
    ).bind(day, crime?.c ?? 0, terry?.c ?? 0, cfsTotal?.c ?? 0, cfsOnview?.c ?? 0).run();
  }

  // Purge stale rows left over from days that no longer have any backing
  // raw data (e.g. the old pre-fix rollup used to always write a "today"
  // row, even with nothing published for it yet — that phantom zero-row
  // would otherwise trail off the end of every chart).
  if (validDays.length) {
    const placeholders = validDays.map(() => "?").join(",");
    await env.DB.prepare(
      `DELETE FROM daily_rollup WHERE day NOT IN (${placeholders})`
    ).bind(...validDays).run();
  } else {
    await env.DB.prepare(`DELETE FROM daily_rollup`).run();
  }
}

// Note: camera capture happens outside this Worker now (GitHub Actions +
// ffmpeg for the HLS streams, direct R2 upload via S3 API, direct D1 insert
// via Cloudflare's HTTP API). This Worker only ever reads camera_snapshots
// rows and serves the images back out — see renderDashboard() and the
// "/snapshot/" route in fetch() below.

// ---- Dashboard rendering ----------------------------------------------------

async function renderDashboard(env) {
  const rollups = await env.DB.prepare(
    `SELECT * FROM daily_rollup ORDER BY day ASC LIMIT 120`
  ).all();
  const latestSnapshots = await env.DB.prepare(
    `SELECT * FROM camera_snapshots ORDER BY captured_at DESC LIMIT 6`
  ).all();
  const cameraNamesResult = await env.DB.prepare(
    `SELECT DISTINCT camera_name FROM camera_snapshots ORDER BY camera_name`
  ).all();

  const rows = rollups.results ?? [];
  const weeklyRows = aggregateWeekly(rows);
  const chartDataJSON = JSON.stringify({
    daily: buildChartSeries(rows),
    weekly: buildChartSeries(weeklyRows),
  });
  const cameraNames = (cameraNamesResult.results ?? []).map((r) => r.camera_name);
  const cameraOptions = cameraNames
    .map((n) => `<option value="${n}">${n.replace(/_/g, " ")}</option>`)
    .join("");

  const snapshotCards = (latestSnapshots.results ?? [])
    .map(
      (s) => `
      <div class="cam-card">
        <img src="/snapshot/${encodeURIComponent(s.r2_key)}" alt="${s.camera_name}" />
        <div class="cam-meta">${s.camera_name} — ${new Date(s.captured_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}</div>
      </div>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>CID / Little Saigon Public Safety Tracker</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>
<style>
  :root {
    --navy-bg: #0a1628;
    --navy-panel: #122642;
    --navy-panel-2: #16304f;
    --navy-border: #1f3d61;
    --red: #c8102e;
    --white: #efe6cc;
    --silver: #aebfd4;
    --gold: #d4af37;
  }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: var(--navy-bg); color: var(--white); }
  .page { max-width: 1100px; margin: 0 auto; padding: 2rem 1.5rem 3rem; }
  h1 { font-size: 1.5rem; margin: 0 0 0.3rem; letter-spacing: 0.01em; }
  h1::before { content: ''; display: inline-block; width: 0.6rem; height: 0.6rem; background: var(--red); border-radius: 2px; margin-right: 0.6rem; }
  h2 { font-size: 1.1rem; margin: 0 0 0.75rem; color: var(--white); }
  .subtitle { color: var(--silver); margin: 0 0 2rem; font-size: 0.9rem; }
  .section { margin-bottom: 2rem; }
  .promises { display: grid; gap: 1rem; grid-template-columns: 1fr 1fr; }
  .promise-card { background: var(--navy-panel); border-radius: 10px; padding: 1rem 1.25rem; border-left: 4px solid var(--red); }
  .promise-card h3 { margin: 0 0 0.4rem; font-size: 0.95rem; color: var(--white); }
  .promise-card p { margin: 0; color: var(--silver); font-size: 0.85rem; }
  .chart-wrap { background: var(--navy-panel); border-radius: 10px; padding: 1.25rem; height: 340px; }
  .view-toggle { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
  .view-toggle button {
    background: var(--navy-panel); color: var(--silver); border: 1px solid var(--navy-border);
    border-radius: 6px; padding: 0.4rem 1rem; font-size: 0.85rem; cursor: pointer;
  }
  .view-toggle button.active { background: var(--red); color: var(--white); border-color: var(--red); }
  .cams { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
  .cam-card { background: var(--navy-panel); border-radius: 10px; padding: 0.6rem; }
  .cam-card img { width: 100%; border-radius: 6px; display: block; }
  .cam-meta { font-size: 0.75rem; color: var(--silver); margin-top: 0.4rem; }
  .browser { background: var(--navy-panel); border-radius: 10px; padding: 1.25rem; }
  .browser-controls { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1rem; }
  .browser-controls select { background: var(--navy-bg); color: var(--white); border: 1px solid var(--navy-border); border-radius: 6px; padding: 0.4rem 0.6rem; font-size: 0.85rem; }
  .browser-controls select:focus { outline: 2px solid var(--red); outline-offset: 1px; }
  .browser img { max-width: 100%; border-radius: 8px; display: block; }
  .browser-meta { font-size: 0.8rem; color: var(--silver); margin-top: 0.5rem; }
  .browser-empty { color: var(--silver); font-size: 0.85rem; }
</style>
</head>
<body>
<div class="page">
  <h1>Chinatown-International District / Little Saigon — Public Safety Tracker</h1>
  <p class="subtitle">Independent tracker built from public SPD/SDOT data. Not affiliated with the City of Seattle.</p>

  <div class="section promises">
    <div class="promise-card">
      <h3>Feb 17, 2026 — State of the City</h3>
      <p>Mayor Wilson pledged SPD would restore a late-night presence in the CID that had been discontinued the prior year.</p>
    </div>
    <div class="promise-card">
      <h3>Jun 18, 2026 — 12th &amp; Jackson enforcement plan</h3>
      <p>Increased police contact for open-air drug activity, LEAD program referrals over arrest, and $1.1M for outreach and mobile treatment services.</p>
    </div>
  </div>

  <div class="view-toggle">
    <button id="dailyBtn" class="active">Daily</button>
    <button id="weeklyBtn">Weekly</button>
  </div>

  <div class="section">
    <h2>Crime reports &amp; Terry stops</h2>
    <div class="chart-wrap"><canvas id="crimeStopsChart"></canvas></div>
  </div>

  <div class="section">
    <h2>Calls for service — on-view vs. other</h2>
    <div class="chart-wrap"><canvas id="callsChart"></canvas></div>
  </div>

  <div class="section">
    <h2>Engagement ratios</h2>
    <p class="subtitle" style="margin-bottom: 0.75rem;">Spikes on low-volume days (e.g. 1 crime report, 2 stops) are small-sample noise, not real swings — gaps mean zero in the denominator that day.</p>
    <div class="chart-wrap"><canvas id="ratiosChart"></canvas></div>
  </div>

  <div class="section">
    <h2>Latest camera snapshots</h2>
    <div class="cams">${snapshotCards || "<p>No snapshots captured yet.</p>"}</div>
  </div>

  <div class="section">
    <h2>Browse camera history</h2>
    <div class="browser">
      <div class="browser-controls">
        <select id="camSelect"><option value="">Select a camera…</option>${cameraOptions}</select>
        <select id="daySelect" disabled><option value="">Day</option></select>
        <select id="timeSelect" disabled><option value="">Time</option></select>
      </div>
      <div id="browserResult"><p class="browser-empty">Pick a camera, then a day and time, to view that snapshot.</p></div>
    </div>
  </div>
</div>

  <script>
    const camSelect = document.getElementById('camSelect');
    const daySelect = document.getElementById('daySelect');
    const timeSelect = document.getElementById('timeSelect');
    const browserResult = document.getElementById('browserResult');
    let snapshotsByCamera = [];

    function fmtDay(iso) {
      return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    }
    function fmtTime(iso) {
      return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
    }

    camSelect.addEventListener('change', async () => {
      daySelect.innerHTML = '<option value="">Day</option>';
      timeSelect.innerHTML = '<option value="">Time</option>';
      daySelect.disabled = true;
      timeSelect.disabled = true;
      browserResult.innerHTML = '<p class="browser-empty">Pick a camera, then a day and time, to view that snapshot.</p>';
      if (!camSelect.value) return;

      const res = await fetch('/api/snapshots?camera=' + encodeURIComponent(camSelect.value));
      snapshotsByCamera = await res.json();
      if (!snapshotsByCamera.length) {
        browserResult.innerHTML = '<p class="browser-empty">No snapshots stored yet for this camera.</p>';
        return;
      }

      const days = [...new Set(snapshotsByCamera.map((s) => fmtDay(s.captured_at)))];
      for (const d of days) {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        daySelect.appendChild(opt);
      }
      daySelect.disabled = false;
    });

    daySelect.addEventListener('change', () => {
      timeSelect.innerHTML = '<option value="">Time</option>';
      timeSelect.disabled = true;
      browserResult.innerHTML = '<p class="browser-empty">Pick a time to view that snapshot.</p>';
      if (!daySelect.value) return;

      const matches = snapshotsByCamera.filter((s) => fmtDay(s.captured_at) === daySelect.value);
      for (const s of matches) {
        const opt = document.createElement('option');
        opt.value = s.r2_key;
        opt.textContent = fmtTime(s.captured_at);
        opt.dataset.capturedAt = s.captured_at;
        timeSelect.appendChild(opt);
      }
      timeSelect.disabled = false;
    });

    timeSelect.addEventListener('change', () => {
      if (!timeSelect.value) {
        browserResult.innerHTML = '<p class="browser-empty">Pick a time to view that snapshot.</p>';
        return;
      }
      const opt = timeSelect.selectedOptions[0];
      const capturedAt = opt.dataset.capturedAt;
      browserResult.innerHTML =
        '<img src="/snapshot/' + encodeURIComponent(timeSelect.value) + '" alt="' + camSelect.value + '" />' +
        '<div class="browser-meta">' + camSelect.value.replace(/_/g, ' ') + ' — ' +
        new Date(capturedAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) + '</div>';
    });
  </script>

  <script>
    const CHART_DATA = ${chartDataJSON};
    let currentView = 'daily';

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    function fmtAxisDate(isoDay) {
      const [, m, d] = isoDay.split('-');
      const md = MONTHS[parseInt(m, 10) - 1] + '-' + d;
      return currentView === 'weekly' ? 'Week of ' + md : md;
    }

    const promiseLinePlugin = {
      id: 'promiseLine',
      afterDraw(chart) {
        const idx = chart.data.labels.indexOf(${JSON.stringify(env.PROMISE_2_DATE)});
        if (idx === -1) return;
        const x = chart.scales.x.getPixelForValue(idx);
        const { top, bottom } = chart.chartArea;
        const c = chart.ctx;
        c.save();
        c.strokeStyle = '#efe6cc';
        c.setLineDash([6, 4]);
        c.lineWidth = 1.5;
        c.beginPath();
        c.moveTo(x, top);
        c.lineTo(x, bottom);
        c.stroke();
        c.setLineDash([]);
        c.fillStyle = '#efe6cc';
        c.font = '11px -apple-system, system-ui, sans-serif';
        c.textAlign = 'left';
        c.fillText('Jun 18: enforcement plan', x + 6, top + 12);
        c.restore();
      },
    };

    const sharedScales = {
      x: {
        ticks: {
          color: '#aebfd4',
          callback: function (value) { return fmtAxisDate(this.getLabelForValue(value)); },
        },
        grid: { color: '#1f3d61' },
      },
      y: { ticks: { color: '#aebfd4' }, grid: { color: '#1f3d61' } },
    };
    const sharedPlugins = {
      legend: { labels: { color: '#efe6cc' } },
      tooltip: { callbacks: { title: (items) => fmtAxisDate(items[0].label) } },
    };
    const sharedScalesPct = {
      x: sharedScales.x,
      y: { ticks: { color: '#aebfd4', callback: (v) => v + '%' }, grid: { color: '#1f3d61' } },
    };
    const sharedPluginsPct = {
      legend: { labels: { color: '#efe6cc' } },
      tooltip: {
        callbacks: {
          title: (items) => fmtAxisDate(items[0].label),
          label: (item) => item.dataset.label + ': ' + item.formattedValue + '%',
        },
      },
    };

    const crimeStopsChart = new Chart(document.getElementById('crimeStopsChart'), {
      type: 'line',
      data: {
        labels: CHART_DATA.daily.labels,
        datasets: [
          { label: 'Crime reports (SPD, daily)', data: CHART_DATA.daily.crime, borderColor: '#c8102e', backgroundColor: '#c8102e', tension: 0.25 },
          { label: 'Terry stops (on-view contacts)', data: CHART_DATA.daily.terry, borderColor: '#aebfd4', backgroundColor: '#aebfd4', tension: 0.25 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: sharedPlugins, scales: sharedScales },
      plugins: [promiseLinePlugin],
    });

    const callsChart = new Chart(document.getElementById('callsChart'), {
      type: 'line',
      data: {
        labels: CHART_DATA.daily.labels,
        datasets: [
          { label: 'CFS on-view calls', data: CHART_DATA.daily.cfsOnview, borderColor: '#d4af37', backgroundColor: '#d4af37', tension: 0.25 },
          { label: 'CFS other calls', data: CHART_DATA.daily.cfsOther, borderColor: '#5b8fc7', backgroundColor: '#5b8fc7', tension: 0.25 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: sharedPlugins, scales: sharedScales },
      plugins: [promiseLinePlugin],
    });

    const ratiosChart = new Chart(document.getElementById('ratiosChart'), {
      type: 'line',
      data: {
        labels: CHART_DATA.daily.labels,
        datasets: [
          { label: 'Terry stops per crime report', data: CHART_DATA.daily.terryPerCrime, borderColor: '#c8102e', backgroundColor: '#c8102e', tension: 0.25, spanGaps: false },
          { label: 'On-view share of calls', data: CHART_DATA.daily.onviewShare, borderColor: '#d4af37', backgroundColor: '#d4af37', tension: 0.25, spanGaps: false },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: sharedPluginsPct, scales: sharedScalesPct },
      plugins: [promiseLinePlugin],
    });

    function applyView(view) {
      currentView = view;
      const d = CHART_DATA[view];

      crimeStopsChart.data.labels = d.labels;
      crimeStopsChart.data.datasets[0].data = d.crime;
      crimeStopsChart.data.datasets[1].data = d.terry;
      crimeStopsChart.update();

      callsChart.data.labels = d.labels;
      callsChart.data.datasets[0].data = d.cfsOnview;
      callsChart.data.datasets[1].data = d.cfsOther;
      callsChart.update();

      ratiosChart.data.labels = d.labels;
      ratiosChart.data.datasets[0].data = d.terryPerCrime;
      ratiosChart.data.datasets[1].data = d.onviewShare;
      ratiosChart.update();

      document.getElementById('dailyBtn').classList.toggle('active', view === 'daily');
      document.getElementById('weeklyBtn').classList.toggle('active', view === 'weekly');
    }

    document.getElementById('dailyBtn').addEventListener('click', () => applyView('daily'));
    document.getElementById('weeklyBtn').addEventListener('click', () => applyView('weekly'));
  </script>
</body>
</html>`;
}

// ---- Worker entrypoints ------------------------------------------------------

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "8 1-23/3 * * *") {
      ctx.waitUntil(dispatchCameraCapture(env));
      return;
    }
    ctx.waitUntil(
      (async () => {
        await pullCrimeData(env);
        await pullTerryStops(env);
        await pullCallsForService(env);
        await rollupDaily(env);
      })()
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const html = await renderDashboard(env);
      return new Response(html, { headers: { "content-type": "text/html; charset=UTF-8" } });
    }

    if (url.pathname.startsWith("/snapshot/")) {
      const key = decodeURIComponent(url.pathname.replace("/snapshot/", ""));
      const obj = await env.CAMERA_SNAPSHOTS.get(key);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body, { headers: { "content-type": "image/jpeg" } });
    }

    if (url.pathname === "/api/snapshots") {
      const camera = url.searchParams.get("camera");
      if (!camera) return new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } });
      const rows = await env.DB.prepare(
        `SELECT captured_at, r2_key FROM camera_snapshots WHERE camera_name = ? ORDER BY captured_at ASC`
      ).bind(camera).all();
      return new Response(JSON.stringify(rows.results ?? []), {
        headers: { "content-type": "application/json" },
      });
    }

    // Manual trigger endpoints for testing without waiting on cron
    if (url.pathname === "/run/daily") {
      const crime = await pullCrimeData(env);
      const terry = await pullTerryStops(env);
      const cfs = await pullCallsForService(env);
      await rollupDaily(env);
      return new Response(JSON.stringify({ crime, terry, cfs }), {
        headers: { "content-type": "application/json" },
      });
    }
    // One-time historical backfill so the trend chart has pre-enforcement
    // context, not just the rolling 7-day catch-up window. Defaults to a
    // week before PROMISE_2_DATE; pass ?since=YYYY-MM-DD to override.
    if (url.pathname === "/run/backfill") {
      const since = url.searchParams.get("since") ?? daysBeforeISO(env.PROMISE_2_DATE, 7);
      const crime = await pullCrimeData(env, since);
      const terry = await pullTerryStops(env, since);
      const cfs = await pullCallsForService(env, since);
      await rollupDaily(env);
      return new Response(JSON.stringify({ since, crime, terry, cfs }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/run/camera-dispatch") {
      const ok = await dispatchCameraCapture(env);
      return new Response(JSON.stringify({ dispatched: ok }), {
        status: ok ? 200 : 502,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};
