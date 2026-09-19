-- Additive extension: previous releases ignore this table during code rollback.
CREATE TABLE IF NOT EXISTS job_metrics (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL CHECK(attempt > 0),
    owner TEXT NOT NULL,
    metrics TEXT NOT NULL CHECK(json_valid(metrics)),
    PRIMARY KEY(job_id, attempt)
);
