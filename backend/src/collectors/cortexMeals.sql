-- Additive feature schema: the connection schema stays readable by the previous runtime.
CREATE TABLE meal_schema (version INTEGER PRIMARY KEY CHECK(version=1));
INSERT INTO meal_schema VALUES (1);
CREATE TABLE meal_publications (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, report_date TEXT NOT NULL,
  station TEXT NOT NULL, service_area_id TEXT NOT NULL, provider TEXT NOT NULL,
  timezone TEXT NOT NULL, started_at TEXT NOT NULL, collected_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
  itinerary_count INTEGER NOT NULL, meal_count INTEGER NOT NULL,
  verified_gap_count INTEGER NOT NULL, adapter_version INTEGER NOT NULL
);
CREATE UNIQUE INDEX active_meal_scope ON meal_publications(report_date,station,service_area_id,provider) WHERE active=1;
CREATE INDEX meal_history ON meal_publications(report_date,collected_at DESC);
CREATE TABLE meal_itineraries (
  publication_id TEXT NOT NULL REFERENCES meal_publications(id) ON DELETE CASCADE,
  itinerary_id TEXT NOT NULL, transporter_id TEXT NOT NULL, driver_name TEXT NOT NULL,
  route_code TEXT NOT NULL, observed_at TEXT NOT NULL, route_complete INTEGER NOT NULL,
  delivery_coverage TEXT NOT NULL CHECK(delivery_coverage IN ('complete','unavailable')),
  meal_state TEXT NOT NULL CHECK(meal_state IN ('none_recorded','in_progress','recorded')),
  PRIMARY KEY(publication_id,itinerary_id)
);
CREATE TABLE meal_delivery_events (
  publication_id TEXT NOT NULL, itinerary_id TEXT NOT NULL, event_id TEXT NOT NULL,
  stop_id TEXT NOT NULL, completed_at TEXT NOT NULL,
  PRIMARY KEY(publication_id,itinerary_id,event_id),
  FOREIGN KEY(publication_id,itinerary_id) REFERENCES meal_itineraries(publication_id,itinerary_id) ON DELETE CASCADE
);
CREATE TABLE meal_breaks (
  publication_id TEXT NOT NULL, itinerary_id TEXT NOT NULL, meal_id TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER,
  prior_event_id TEXT, next_event_id TEXT, gap_before_seconds INTEGER, gap_after_seconds INTEGER,
  before_status TEXT NOT NULL CHECK(before_status IN ('verified','absent','unavailable')),
  after_status TEXT NOT NULL CHECK(after_status IN ('verified','absent','pending','unavailable')),
  PRIMARY KEY(publication_id,itinerary_id,meal_id),
  FOREIGN KEY(publication_id,itinerary_id) REFERENCES meal_itineraries(publication_id,itinerary_id) ON DELETE CASCADE,
  FOREIGN KEY(publication_id,itinerary_id,prior_event_id) REFERENCES meal_delivery_events(publication_id,itinerary_id,event_id),
  FOREIGN KEY(publication_id,itinerary_id,next_event_id) REFERENCES meal_delivery_events(publication_id,itinerary_id,event_id)
);
