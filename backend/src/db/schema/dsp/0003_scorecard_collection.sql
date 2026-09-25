-- collection_schedules.collection names every collection in a CHECK, which SQLite
-- cannot widen in place, so the table is rebuilt with the scorecard collection.
-- Nothing references it. The release that ships this never saves the new
-- collection; the next one does, once a rollback target accepts it.
CREATE TABLE collection_schedules_v2 (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, collection TEXT NOT NULL CHECK(collection IN ('paycom','meal_break','both','scorecard')),
    cadence TEXT NOT NULL CHECK(cadence IN ('interval','daily')), interval_minutes INTEGER, local_time TEXT NOT NULL,
    anchor INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), next_run TEXT,
    revision INTEGER NOT NULL DEFAULT 1, last_error TEXT, created_at TEXT NOT NULL
);
INSERT INTO collection_schedules_v2 (id,name,collection,cadence,interval_minutes,local_time,anchor,enabled,next_run,revision,last_error,created_at)
  SELECT id,name,collection,cadence,interval_minutes,local_time,anchor,enabled,next_run,revision,last_error,created_at FROM collection_schedules;
DROP TABLE collection_schedules;
ALTER TABLE collection_schedules_v2 RENAME TO collection_schedules;
