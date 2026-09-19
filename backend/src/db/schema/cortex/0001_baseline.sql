CREATE TABLE IF NOT EXISTS connections (provider TEXT PRIMARY KEY CHECK(provider='cortex'), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), status TEXT NOT NULL DEFAULT 'not_connected', error TEXT, account_label TEXT, updated_at TEXT NOT NULL, verified_at TEXT, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS storage_identity (dsp_id TEXT NOT NULL, provider TEXT NOT NULL, source TEXT NOT NULL);

-- Additive feature schema: the connection schema stays readable by the previous runtime.
CREATE TABLE IF NOT EXISTS meal_schema (version INTEGER PRIMARY KEY CHECK(version=1));
INSERT OR IGNORE INTO meal_schema VALUES (1);
CREATE TABLE IF NOT EXISTS meal_publications (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, report_date TEXT NOT NULL,
  station TEXT NOT NULL, service_area_id TEXT NOT NULL, provider TEXT NOT NULL,
  timezone TEXT NOT NULL, started_at TEXT NOT NULL, collected_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
  itinerary_count INTEGER NOT NULL, meal_count INTEGER NOT NULL,
  verified_gap_count INTEGER NOT NULL, adapter_version INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS active_meal_scope ON meal_publications(report_date,station,service_area_id,provider) WHERE active=1;
CREATE INDEX IF NOT EXISTS meal_history ON meal_publications(report_date,collected_at DESC);
CREATE TABLE IF NOT EXISTS meal_itineraries (
  publication_id TEXT NOT NULL REFERENCES meal_publications(id) ON DELETE CASCADE,
  itinerary_id TEXT NOT NULL, transporter_id TEXT NOT NULL, driver_name TEXT NOT NULL,
  route_code TEXT NOT NULL, observed_at TEXT NOT NULL, route_complete INTEGER NOT NULL,
  delivery_coverage TEXT NOT NULL CHECK(delivery_coverage IN ('complete','unavailable')),
  meal_state TEXT NOT NULL CHECK(meal_state IN ('none_recorded','in_progress','recorded')),
  PRIMARY KEY(publication_id,itinerary_id)
);
CREATE TABLE IF NOT EXISTS meal_delivery_events (
  publication_id TEXT NOT NULL, itinerary_id TEXT NOT NULL, event_id TEXT NOT NULL,
  stop_id TEXT NOT NULL, completed_at TEXT NOT NULL,
  PRIMARY KEY(publication_id,itinerary_id,event_id),
  FOREIGN KEY(publication_id,itinerary_id) REFERENCES meal_itineraries(publication_id,itinerary_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS meal_breaks (
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

-- Four timestamps per logical meal. Identity and availability accompany the times;
-- package/task IDs, stop IDs and full delivery history are not retained.
CREATE TABLE IF NOT EXISTS meal_record_schema (version INTEGER PRIMARY KEY CHECK(version=1));
INSERT OR IGNORE INTO meal_record_schema VALUES (1);
CREATE TABLE IF NOT EXISTS meal_records (
  publication_id TEXT NOT NULL, itinerary_id TEXT NOT NULL, meal_id TEXT NOT NULL,
  last_delivery_at TEXT, started_at TEXT NOT NULL, ended_at TEXT, first_delivery_at TEXT,
  before_status TEXT NOT NULL CHECK(before_status IN ('verified','absent','unavailable')),
  after_status TEXT NOT NULL CHECK(after_status IN ('verified','absent','pending','unavailable')),
  PRIMARY KEY(publication_id,itinerary_id,meal_id),
  FOREIGN KEY(publication_id,itinerary_id) REFERENCES meal_itineraries(publication_id,itinerary_id) ON DELETE CASCADE,
  CHECK((before_status='verified')=(last_delivery_at IS NOT NULL)),
  CHECK((after_status='verified')=(first_delivery_at IS NOT NULL)),
  CHECK(last_delivery_at IS NULL OR last_delivery_at<=started_at),
  CHECK(ended_at IS NULL OR ended_at>=started_at),
  CHECK(first_delivery_at IS NULL OR (ended_at IS NOT NULL AND first_delivery_at>=ended_at))
);

-- Delivery history written before meal_records existed becomes records. The trigger
-- below has kept both legacy tables empty ever since, so this changes nothing on a
-- database that was already converted.
INSERT OR IGNORE INTO meal_records
SELECT b.publication_id,b.itinerary_id,b.meal_id,p.completed_at,b.started_at,b.ended_at,n.completed_at,b.before_status,b.after_status
FROM meal_breaks b
LEFT JOIN meal_delivery_events p ON p.publication_id=b.publication_id AND p.itinerary_id=b.itinerary_id AND p.event_id=b.prior_event_id
LEFT JOIN meal_delivery_events n ON n.publication_id=b.publication_id AND n.itinerary_id=b.itinerary_id AND n.event_id=b.next_event_id;
DELETE FROM meal_breaks;
DELETE FROM meal_delivery_events;

-- Keep the previous runtime able to start and publish during code rollback.
-- Convert its legacy writes in the same publication transaction so a rollback
-- cannot resume retaining full delivery histories. The legacy tables stay empty.
CREATE TRIGGER IF NOT EXISTS minimize_legacy_meal_publication AFTER UPDATE OF active ON meal_publications
WHEN NEW.active=1
BEGIN
  INSERT INTO meal_records
  SELECT b.publication_id,b.itinerary_id,b.meal_id,p.completed_at,b.started_at,b.ended_at,n.completed_at,b.before_status,b.after_status
  FROM meal_breaks b
  LEFT JOIN meal_delivery_events p ON p.publication_id=b.publication_id AND p.itinerary_id=b.itinerary_id AND p.event_id=b.prior_event_id
  LEFT JOIN meal_delivery_events n ON n.publication_id=b.publication_id AND n.itinerary_id=b.itinerary_id AND n.event_id=b.next_event_id
  WHERE b.publication_id=NEW.id;
  DELETE FROM meal_breaks WHERE publication_id=NEW.id;
  DELETE FROM meal_delivery_events WHERE publication_id=NEW.id;
END;

-- The Cortex page each itinerary was read from.
CREATE TABLE IF NOT EXISTS meal_sources (publication_id TEXT NOT NULL, itinerary_id TEXT NOT NULL, url TEXT NOT NULL, PRIMARY KEY(publication_id,itinerary_id), FOREIGN KEY(publication_id,itinerary_id) REFERENCES meal_itineraries(publication_id,itinerary_id) ON DELETE CASCADE);

-- Live rows of the running collection.
CREATE TABLE IF NOT EXISTS collection_live_runs (job_id TEXT PRIMARY KEY, owner TEXT NOT NULL, metadata TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collection_live_items (job_id TEXT NOT NULL REFERENCES collection_live_runs(job_id) ON DELETE CASCADE, item_key TEXT NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job_id,date,item_key));
