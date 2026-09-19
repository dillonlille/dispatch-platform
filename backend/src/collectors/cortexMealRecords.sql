-- Four timestamps per logical meal. Identity and availability accompany the times;
-- package/task IDs, stop IDs and full delivery history are not retained.
CREATE TABLE meal_record_schema (version INTEGER PRIMARY KEY CHECK(version=1));
INSERT INTO meal_record_schema VALUES (1);
CREATE TABLE meal_records (
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

INSERT INTO meal_records
SELECT b.publication_id,b.itinerary_id,b.meal_id,p.completed_at,b.started_at,b.ended_at,n.completed_at,b.before_status,b.after_status
FROM meal_breaks b
LEFT JOIN meal_delivery_events p ON p.publication_id=b.publication_id AND p.itinerary_id=b.itinerary_id AND p.event_id=b.prior_event_id
LEFT JOIN meal_delivery_events n ON n.publication_id=b.publication_id AND n.itinerary_id=b.itinerary_id AND n.event_id=b.next_event_id;
DELETE FROM meal_breaks;
DELETE FROM meal_delivery_events;

-- Keep the previous runtime able to start and publish during code rollback.
-- Convert its legacy writes in the same publication transaction so a rollback
-- cannot resume retaining full delivery histories. The legacy tables stay empty.
CREATE TRIGGER minimize_legacy_meal_publication AFTER UPDATE OF active ON meal_publications
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
