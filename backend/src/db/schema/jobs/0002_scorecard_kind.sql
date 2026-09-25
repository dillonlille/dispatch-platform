-- jobs.kind names every job kind in a CHECK, which SQLite cannot widen in place, so
-- the table is rebuilt with the scorecard kind. job_metrics references jobs and would
-- lose its rows to ON DELETE CASCADE when jobs is dropped, so it is rebuilt first,
-- against the new table, and the old tables go child before parent. The renames make
-- job_metrics reference jobs again. The release that ships this never queues the new
-- kind; the next one does, once a rollback target accepts it.
CREATE TABLE jobs_v2 (id TEXT PRIMARY KEY, dsp_id TEXT NOT NULL, environment TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('paycom.collect','cortex.meal_breaks.collect','cortex.scorecard.collect')), status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_verification','succeeded','failed','cancelled')), progress INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT 'Waiting for a worker', attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, available_at INTEGER NOT NULL, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, error TEXT, release TEXT NOT NULL, actor_id TEXT, lease_owner TEXT, lease_until INTEGER, connection_revision INTEGER NOT NULL, idempotency_key TEXT NOT NULL, request TEXT NOT NULL DEFAULT '{}', UNIQUE(dsp_id,idempotency_key));
INSERT INTO jobs_v2 (id,dsp_id,environment,kind,status,progress,message,attempt,max_attempts,available_at,created_at,started_at,completed_at,error,release,actor_id,lease_owner,lease_until,connection_revision,idempotency_key,request)
  SELECT id,dsp_id,environment,kind,status,progress,message,attempt,max_attempts,available_at,created_at,started_at,completed_at,error,release,actor_id,lease_owner,lease_until,connection_revision,idempotency_key,request FROM jobs;
CREATE TABLE job_metrics_v2 (
    job_id TEXT NOT NULL REFERENCES jobs_v2(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL CHECK(attempt > 0),
    owner TEXT NOT NULL,
    metrics TEXT NOT NULL CHECK(json_valid(metrics)),
    PRIMARY KEY(job_id, attempt)
);
INSERT INTO job_metrics_v2 (job_id,attempt,owner,metrics) SELECT job_id,attempt,owner,metrics FROM job_metrics;
DROP TABLE job_metrics;
DROP TABLE jobs;
ALTER TABLE jobs_v2 RENAME TO jobs;
ALTER TABLE job_metrics_v2 RENAME TO job_metrics;
CREATE INDEX IF NOT EXISTS jobs_claim ON jobs(status,available_at,created_at);
CREATE INDEX IF NOT EXISTS jobs_dsp ON jobs(dsp_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_dsp ON jobs(dsp_id) WHERE status IN ('running','waiting_verification');
CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at DESC);
