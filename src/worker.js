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

async function pullCrimeData(env) {
  // Crime dataset dropped MCPP from its published fields — beat is now the
  // only reliable geography filter across all three SPD datasets.
  const beats = (env.CID_BEATS || "").split(",").map((b) => b.trim()).filter(Boolean);
  if (!beats.length) return 0;
  const beatClause = beats.map((b) => `'${b}'`).join(",");

  let rows;
  try {
    rows = await socrataFetch(
      DATASETS.crime,
      {
        // TODO verify: confirmed live 2026-07 that this dataset's date
        // column is "offense_date", not "occurred_date" as originally
        // scaffolded.
        "$where": `beat in (${beatClause}) AND offense_date > '${daysAgoISO(7)}'`,
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

async function pullTerryStops(env) {
  const beats = (env.CID_BEATS || "").split(",").map((b) => b.trim()).filter(Boolean);
  if (!beats.length) return 0;

  const beatClause = beats.map((b) => `'${b}'`).join(",");
  let rows;
  try {
    rows = await socrataFetch(
      DATASETS.terryStops,
      {
        // TODO verify: confirmed live 2026-07 that this dataset's date
        // column is "occurred_date", not "stop_date" as originally
        // scaffolded.
        "$where": `beat in (${beatClause}) AND occurred_date > '${daysAgoISO(7)}'`,
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

async function pullCallsForService(env) {
  const beats = (env.CID_BEATS || "").split(",").map((b) => b.trim()).filter(Boolean);
  if (!beats.length) return 0;

  const beatClause = beats.map((b) => `'${b}'`).join(",");
  let rows;
  try {
    // TODO verify: confirmed live 2026-07 that resource ID 33kz-ixgy is
    // still valid, but Seattle renamed several columns (privacy-model
    // republish) — beat -> dispatch_beat, original_time_queued ->
    // cad_event_original_time_queued.
    rows = await socrataFetch(
      DATASETS.callsForService,
      {
        "$where": `dispatch_beat in (${beatClause}) AND cad_event_original_time_queued > '${daysAgoISO(7)}'`,
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

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
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

  for (const { day } of daysResult.results ?? []) {
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
  const labels = JSON.stringify(rows.map((r) => r.day));
  const crimeData = JSON.stringify(rows.map((r) => r.crime_count));
  const terryData = JSON.stringify(rows.map((r) => r.terry_stop_count));
  const cfsOnviewData = JSON.stringify(rows.map((r) => r.cfs_onview));
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
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 2rem; background: #0f1115; color: #e8e8e8; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  .subtitle { color: #9aa0a6; margin-bottom: 2rem; }
  .promises { display: grid; gap: 1rem; grid-template-columns: 1fr 1fr; margin-bottom: 2rem; }
  .promise-card { background: #1a1d24; border-radius: 10px; padding: 1rem 1.25rem; border-left: 4px solid #4d8dff; }
  .promise-card h3 { margin: 0 0 0.4rem; font-size: 0.95rem; }
  .promise-card p { margin: 0; color: #b7bcc4; font-size: 0.85rem; }
  canvas { background: #1a1d24; border-radius: 10px; padding: 1rem; margin-bottom: 2rem; }
  .cams { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
  .cam-card img { width: 100%; border-radius: 8px; display: block; }
  .cam-meta { font-size: 0.75rem; color: #9aa0a6; margin-top: 0.3rem; }
  .browser { background: #1a1d24; border-radius: 10px; padding: 1.25rem; margin: 1rem 0 2rem; }
  .browser-controls { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1rem; }
  .browser-controls select { background: #0f1115; color: #e8e8e8; border: 1px solid #2a2e37; border-radius: 6px; padding: 0.4rem 0.6rem; font-size: 0.85rem; }
  .browser img { max-width: 100%; border-radius: 8px; display: block; }
  .browser-meta { font-size: 0.8rem; color: #9aa0a6; margin-top: 0.5rem; }
  .browser-empty { color: #9aa0a6; font-size: 0.85rem; }
</style>
</head>
<body>
  <h1>Chinatown-International District / Little Saigon — Public Safety Tracker</h1>
  <p class="subtitle">Independent tracker built from public SPD/SDOT data. Not affiliated with the City of Seattle.</p>

  <div class="promises">
    <div class="promise-card">
      <h3>Feb 17, 2026 — State of the City</h3>
      <p>Mayor Wilson pledged SPD would restore a late-night presence in the CID that had been discontinued the prior year.</p>
    </div>
    <div class="promise-card">
      <h3>Jun 18, 2026 — 12th &amp; Jackson enforcement plan</h3>
      <p>Increased police contact for open-air drug activity, LEAD program referrals over arrest, and $1.1M for outreach and mobile treatment services.</p>
    </div>
  </div>

  <canvas id="trendChart" height="90"></canvas>

  <h2 style="font-size:1.1rem;">Latest camera snapshots</h2>
  <div class="cams">${snapshotCards || "<p>No snapshots captured yet.</p>"}</div>

  <h2 style="font-size:1.1rem;">Browse camera history</h2>
  <div class="browser">
    <div class="browser-controls">
      <select id="camSelect"><option value="">Select a camera…</option>${cameraOptions}</select>
      <select id="daySelect" disabled><option value="">Day</option></select>
      <select id="timeSelect" disabled><option value="">Time</option></select>
    </div>
    <div id="browserResult"><p class="browser-empty">Pick a camera, then a day and time, to view that snapshot.</p></div>
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
    const ctx = document.getElementById('trendChart');
    new Chart(ctx, {
      type: 'line',
      data: {
        labels: ${labels},
        datasets: [
          { label: 'Crime reports (SPD, daily)', data: ${crimeData}, borderColor: '#ff6b6b', tension: 0.25 },
          { label: 'Terry stops (on-view contacts)', data: ${terryData}, borderColor: '#4d8dff', tension: 0.25 },
          { label: 'CFS on-view calls', data: ${cfsOnviewData}, borderColor: '#ffd166', tension: 0.25 },
        ],
      },
      options: {
        plugins: { legend: { labels: { color: '#e8e8e8' } } },
        scales: {
          x: { ticks: { color: '#9aa0a6' }, grid: { color: '#2a2e37' } },
          y: { ticks: { color: '#9aa0a6' }, grid: { color: '#2a2e37' } },
        },
      },
    });
  </script>
</body>
</html>`;
}

// ---- Worker entrypoints ------------------------------------------------------

export default {
  async scheduled(event, env, ctx) {
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
    return new Response("Not found", { status: 404 });
  },
};
