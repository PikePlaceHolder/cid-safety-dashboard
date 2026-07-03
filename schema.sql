-- CID Safety Dashboard schema
-- Apply with: wrangler d1 execute cid_safety --file=schema.sql

CREATE TABLE IF NOT EXISTS crime_events (
  report_number   TEXT PRIMARY KEY,
  offense         TEXT,
  offense_category TEXT,
  occurred_date   TEXT,
  mcpp            TEXT,
  precinct        TEXT,
  sector          TEXT,
  beat            TEXT,
  fetched_at      TEXT
);

CREATE TABLE IF NOT EXISTS terry_stops (
  stop_id           TEXT PRIMARY KEY,
  stop_date         TEXT,
  precinct          TEXT,
  sector            TEXT,
  beat              TEXT,
  stop_resolution   TEXT,   -- e.g. Arrest, Citation/Infraction, Field Contact, Offense Report
  initial_call_type TEXT,
  final_call_type   TEXT,
  fetched_at        TEXT
);

CREATE TABLE IF NOT EXISTS calls_for_service (
  cad_event_number  TEXT PRIMARY KEY,
  call_date         TEXT,
  initial_call_type TEXT,
  final_call_type   TEXT,
  beat              TEXT,
  precinct          TEXT,
  officer_initiated INTEGER,  -- 1 if initial_call_type indicates on-view, else 0
  fetched_at        TEXT
);

-- Precomputed daily counters so the dashboard page doesn't have to scan raw tables
CREATE TABLE IF NOT EXISTS daily_rollup (
  day             TEXT PRIMARY KEY,  -- YYYY-MM-DD
  crime_count     INTEGER DEFAULT 0,
  terry_stop_count INTEGER DEFAULT 0,
  cfs_total       INTEGER DEFAULT 0,
  cfs_onview      INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS camera_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_name   TEXT,
  lat           REAL,
  lon           REAL,
  r2_key        TEXT,
  captured_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_crime_occurred ON crime_events(occurred_date);
CREATE INDEX IF NOT EXISTS idx_terry_date ON terry_stops(stop_date);
CREATE INDEX IF NOT EXISTS idx_cfs_date ON calls_for_service(call_date);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON camera_snapshots(captured_at);
