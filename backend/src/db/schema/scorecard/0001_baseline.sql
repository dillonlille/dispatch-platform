CREATE TABLE IF NOT EXISTS storage_identity (dsp_id TEXT NOT NULL, provider TEXT NOT NULL, source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scorecard_schema (version INTEGER PRIMARY KEY CHECK(version=1));
INSERT OR IGNORE INTO scorecard_schema VALUES (1);

-- One collection of one week's scorecard. The newest collection of a week is active;
-- earlier ones stay, since dispute outcomes change a week after it is posted.
CREATE TABLE IF NOT EXISTS scorecard_publications (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, week TEXT NOT NULL, station TEXT NOT NULL,
  company_id TEXT NOT NULL, dsp_code TEXT NOT NULL, started_at TEXT NOT NULL, collected_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)), row_count INTEGER NOT NULL, adapter_version INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS active_scorecard_week ON scorecard_publications(week,station,company_id) WHERE active=1;
CREATE INDEX IF NOT EXISTS scorecard_history ON scorecard_publications(week,collected_at DESC);

-- What the last collection of each week found at a station: posted, or not yet.
CREATE TABLE IF NOT EXISTS scorecard_weeks (
  week TEXT NOT NULL, station TEXT NOT NULL, checked_at TEXT NOT NULL,
  posted INTEGER NOT NULL CHECK(posted IN (0,1)),
  publication_id TEXT REFERENCES scorecard_publications(id) ON DELETE SET NULL,
  PRIMARY KEY(week,station)
);

-- One table per dataset, all alike: the row Amazon sent, as JSON, beside the keys
-- reads filter on. A key the dataset lacks stays NULL.
-- da_dsp_station_weekly_performance: one row per driver per week, the overview spreadsheet
CREATE TABLE IF NOT EXISTS driver_scorecards (
  publication_id TEXT NOT NULL REFERENCES scorecard_publications(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL, week TEXT, data_date TEXT, transporter_id TEXT, tracking_id TEXT, event_id TEXT,
  impact INTEGER, row TEXT NOT NULL CHECK(json_valid(row)), PRIMARY KEY(publication_id,row_index)
);
CREATE INDEX IF NOT EXISTS driver_scorecards_transporter ON driver_scorecards(transporter_id);
-- da_dsp_station_weekly_safety_oss_v2: one row per driver per week
CREATE TABLE IF NOT EXISTS driver_safety (
  publication_id TEXT NOT NULL REFERENCES scorecard_publications(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL, week TEXT, data_date TEXT, transporter_id TEXT, tracking_id TEXT, event_id TEXT,
  impact INTEGER, row TEXT NOT NULL CHECK(json_valid(row)), PRIMARY KEY(publication_id,row_index)
);
CREATE INDEX IF NOT EXISTS driver_safety_transporter ON driver_safety(transporter_id);
-- da_dsp_weekly_rts_deep_dive: one row per returned package (Delivery Completion DPMO)
CREATE TABLE IF NOT EXISTS returns_to_station (
  publication_id TEXT NOT NULL REFERENCES scorecard_publications(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL, week TEXT, data_date TEXT, transporter_id TEXT, tracking_id TEXT, event_id TEXT,
  impact INTEGER, row TEXT NOT NULL CHECK(json_valid(row)), PRIMARY KEY(publication_id,row_index)
);
CREATE INDEX IF NOT EXISTS returns_to_station_transporter ON returns_to_station(transporter_id);
-- da_dsp_weekly_cdf_deep_dive: one row per delivery with customer feedback, positive or negative
CREATE TABLE IF NOT EXISTS customer_feedback (
  publication_id TEXT NOT NULL REFERENCES scorecard_publications(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL, week TEXT, data_date TEXT, transporter_id TEXT, tracking_id TEXT, event_id TEXT,
  impact INTEGER, row TEXT NOT NULL CHECK(json_valid(row)), PRIMARY KEY(publication_id,row_index)
);
CREATE INDEX IF NOT EXISTS customer_feedback_transporter ON customer_feedback(transporter_id);
-- da_dsp_station_daily_dsb_dnr_tba: one row per concession (Delivery Success Behaviors)
CREATE TABLE IF NOT EXISTS delivery_concessions (
  publication_id TEXT NOT NULL REFERENCES scorecard_publications(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL, week TEXT, data_date TEXT, transporter_id TEXT, tracking_id TEXT, event_id TEXT,
  impact INTEGER, row TEXT NOT NULL CHECK(json_valid(row)), PRIMARY KEY(publication_id,row_index)
);
CREATE INDEX IF NOT EXISTS delivery_concessions_transporter ON delivery_concessions(transporter_id);
-- da_dsp_daily_psb_stop: one row per pickup stop failure (Pickup Success Behaviors)
CREATE TABLE IF NOT EXISTS pickup_failures (
  publication_id TEXT NOT NULL REFERENCES scorecard_publications(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL, week TEXT, data_date TEXT, transporter_id TEXT, tracking_id TEXT, event_id TEXT,
  impact INTEGER, row TEXT NOT NULL CHECK(json_valid(row)), PRIMARY KEY(publication_id,row_index)
);
CREATE INDEX IF NOT EXISTS pickup_failures_transporter ON pickup_failures(transporter_id);
-- da_dsp_station_daily_safety_oss_events_intraday: one row per Netradyne event
CREATE TABLE IF NOT EXISTS safety_events (
  publication_id TEXT NOT NULL REFERENCES scorecard_publications(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL, week TEXT, data_date TEXT, transporter_id TEXT, tracking_id TEXT, event_id TEXT,
  impact INTEGER, row TEXT NOT NULL CHECK(json_valid(row)), PRIMARY KEY(publication_id,row_index)
);
CREATE INDEX IF NOT EXISTS safety_events_transporter ON safety_events(transporter_id);
-- dsp_station_weekly_quality: the DSP's weekly scorecard, one row
CREATE TABLE IF NOT EXISTS dsp_quality (
  publication_id TEXT NOT NULL REFERENCES scorecard_publications(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL, week TEXT, data_date TEXT, transporter_id TEXT, tracking_id TEXT, event_id TEXT,
  impact INTEGER, row TEXT NOT NULL CHECK(json_valid(row)), PRIMARY KEY(publication_id,row_index)
);
CREATE INDEX IF NOT EXISTS dsp_quality_transporter ON dsp_quality(transporter_id);
-- dsp_station_weekly_team: one row
CREATE TABLE IF NOT EXISTS dsp_team (
  publication_id TEXT NOT NULL REFERENCES scorecard_publications(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL, week TEXT, data_date TEXT, transporter_id TEXT, tracking_id TEXT, event_id TEXT,
  impact INTEGER, row TEXT NOT NULL CHECK(json_valid(row)), PRIMARY KEY(publication_id,row_index)
);
CREATE INDEX IF NOT EXISTS dsp_team_transporter ON dsp_team(transporter_id);
-- dsp_station_weekly_compliance: one row
CREATE TABLE IF NOT EXISTS dsp_compliance (
  publication_id TEXT NOT NULL REFERENCES scorecard_publications(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL, week TEXT, data_date TEXT, transporter_id TEXT, tracking_id TEXT, event_id TEXT,
  impact INTEGER, row TEXT NOT NULL CHECK(json_valid(row)), PRIMARY KEY(publication_id,row_index)
);
CREATE INDEX IF NOT EXISTS dsp_compliance_transporter ON dsp_compliance(transporter_id);
-- dsp_station_weekly_safety_oss_v2: one row
CREATE TABLE IF NOT EXISTS dsp_safety (
  publication_id TEXT NOT NULL REFERENCES scorecard_publications(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL, week TEXT, data_date TEXT, transporter_id TEXT, tracking_id TEXT, event_id TEXT,
  impact INTEGER, row TEXT NOT NULL CHECK(json_valid(row)), PRIMARY KEY(publication_id,row_index)
);
CREATE INDEX IF NOT EXISTS dsp_safety_transporter ON dsp_safety(transporter_id);
-- dsp_station_weekly_working_device: one row
CREATE TABLE IF NOT EXISTS dsp_working_device (
  publication_id TEXT NOT NULL REFERENCES scorecard_publications(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL, week TEXT, data_date TEXT, transporter_id TEXT, tracking_id TEXT, event_id TEXT,
  impact INTEGER, row TEXT NOT NULL CHECK(json_valid(row)), PRIMARY KEY(publication_id,row_index)
);
CREATE INDEX IF NOT EXISTS dsp_working_device_transporter ON dsp_working_device(transporter_id);
-- dsp_weekly_cdf: one row of feedback counts
CREATE TABLE IF NOT EXISTS dsp_feedback (
  publication_id TEXT NOT NULL REFERENCES scorecard_publications(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL, week TEXT, data_date TEXT, transporter_id TEXT, tracking_id TEXT, event_id TEXT,
  impact INTEGER, row TEXT NOT NULL CHECK(json_valid(row)), PRIMARY KEY(publication_id,row_index)
);
CREATE INDEX IF NOT EXISTS dsp_feedback_transporter ON dsp_feedback(transporter_id);
-- dsp_weekly_psb: one row of pickup counts
CREATE TABLE IF NOT EXISTS dsp_pickups (
  publication_id TEXT NOT NULL REFERENCES scorecard_publications(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL, week TEXT, data_date TEXT, transporter_id TEXT, tracking_id TEXT, event_id TEXT,
  impact INTEGER, row TEXT NOT NULL CHECK(json_valid(row)), PRIMARY KEY(publication_id,row_index)
);
CREATE INDEX IF NOT EXISTS dsp_pickups_transporter ON dsp_pickups(transporter_id);
