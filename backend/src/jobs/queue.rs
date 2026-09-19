use crate::collectors::Provider;
use crate::{
    Code, Error, Result,
    contracts::{ActiveJobStatus, Dsp, JobRow, JobStatus, PublicJob, UserStatus},
    crypto,
    db::{AuditChange, FromRow, Row, Store, iso, now},
    ensure,
    job_metrics::Metrics,
    job_statuses,
};
use rusqlite::params;
use serde_json::{Value, json};
use std::collections::HashMap;

const RECENT: &str = "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200";
const RECENT_FOR_DSP: &str = "SELECT * FROM jobs WHERE dsp_id=? ORDER BY created_at DESC LIMIT 200";
const DSP_NAMES: &str = "SELECT id,name FROM dsps WHERE id IN (SELECT value FROM json_each(?))";
const METRICS: &str = "SELECT job_id,metrics FROM job_metrics \
    WHERE job_id IN (SELECT value FROM json_each(?)) ORDER BY attempt";
const JOB: &str = "SELECT * FROM jobs WHERE id=? AND (? IS NULL OR dsp_id=?)";
const ACTIVE_COUNT: &str = concat!(
    "SELECT count(*) FROM jobs WHERE dsp_id=? AND status IN ",
    job_statuses!(active)
);
const LEASED_COUNT: &str = concat!(
    "SELECT count(*) FROM jobs WHERE status IN ",
    job_statuses!(leased)
);
const INSERT: &str = "INSERT INTO jobs(id,dsp_id,environment,kind,status,available_at,created_at,\
    release,actor_id,connection_revision,idempotency_key,request) \
    VALUES (?,?,?,?,'queued',?,?,?,?,?,?,?)";
// The oldest queued job of the DSP that has waited longest since its last collection,
// among DSPs no worker is collecting for.
const CLAIMABLE: &str = concat!(
    "SELECT * FROM jobs j WHERE j.status='queued' AND j.available_at<=? AND NOT EXISTS \
     (SELECT 1 FROM jobs active WHERE active.dsp_id=j.dsp_id AND active.status IN ",
    job_statuses!(leased),
    ") ORDER BY (SELECT COALESCE(MAX(completed_at),'') FROM jobs previous \
     WHERE previous.dsp_id=j.dsp_id),j.created_at LIMIT 200"
);
const CANCEL: &str = concat!(
    "UPDATE jobs SET status='cancelled',message='Cancelled',completed_at=?,\
     lease_owner=NULL,lease_until=NULL WHERE status IN ",
    job_statuses!(active)
);
const START: &str = "UPDATE jobs SET status='running',attempt=attempt+1,started_at=?,lease_owner=?,\
    lease_until=?,message='Starting collection' WHERE id=?";
const PROGRESS: &str = concat!(
    "UPDATE jobs SET progress=?,message=?,status=? WHERE id=? AND lease_owner=? AND status IN ",
    job_statuses!(leased)
);
const FINISH: &str = "UPDATE jobs SET status=?,progress=?,message=?,error=?,completed_at=?,\
    available_at=?,lease_owner=NULL,lease_until=NULL WHERE id=?";
const CANCEL_RUNNING_METRICS: &str = "UPDATE job_metrics SET owner='',metrics=json_set(metrics,\
    '$.outcome','cancelled','$.error','job_cancelled','$.phase',NULL,'$.finishedAt',?) \
    WHERE json_extract(metrics,'$.outcome')='running' \
    AND job_id IN (SELECT id FROM jobs WHERE status='cancelled')";
const INTERRUPT_METRICS: &str = concat!(
    "UPDATE job_metrics SET owner='',metrics=json_set(metrics,'$.outcome','interrupted',\
     '$.error','worker_interrupted','$.phase',NULL,'$.finishedAt',?) \
     WHERE json_extract(metrics,'$.outcome')='running' \
     AND job_id IN (SELECT id FROM jobs WHERE status IN ",
    job_statuses!(leased),
    " AND (? OR lease_until<?))"
);
const RECOVER: &str = concat!(
    "UPDATE jobs SET status=CASE WHEN attempt>=max_attempts THEN 'failed' ELSE 'queued' END,\
     message='Recovered interrupted collection',error='worker_interrupted',available_at=?,\
     completed_at=CASE WHEN attempt>=max_attempts THEN ? ELSE NULL END,\
     lease_owner=NULL,lease_until=NULL WHERE status IN ",
    job_statuses!(leased),
    " AND (? OR lease_until<?)"
);

/// Which unfinished jobs a cancellation reaches.
pub enum CancelJobs<'a> {
    Job { id: &'a str, dsp: &'a str },
    Provider { dsp: &'a str, provider: Provider },
    Dsp(&'a str),
}
/// What a worker needs to know about a provider's connection before it collects.
pub(crate) struct ConnectionLease {
    pub enabled: bool,
    pub revision: i64,
}
impl FromRow for ConnectionLease {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            enabled: row.get("enabled")?,
            revision: row.get("revision")?,
        })
    }
}
struct Claimable {
    id: String,
    dsp_id: String,
    kind: String,
}
impl FromRow for Claimable {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            dsp_id: row.get("dsp_id")?,
            kind: row.get("kind")?,
        })
    }
}
/// The parts of a job its outcome's log entry is written from.
pub struct JobFacts<'a> {
    pub idempotency_key: &'a str,
    pub provider: Option<Provider>,
    pub attempt: i64,
    pub max_attempts: i64,
    pub request: &'a str,
    pub started_at: Option<&'a str>,
}
impl<'a> From<&'a JobRow> for JobFacts<'a> {
    fn from(job: &'a JobRow) -> Self {
        Self {
            idempotency_key: &job.idempotency_key,
            provider: Some(job.provider()),
            attempt: job.attempt,
            max_attempts: job.max_attempts,
            request: &job.request,
            started_at: job.started_at.as_deref(),
        }
    }
}
impl Store {
    pub(crate) fn connection_lease(
        &self,
        dsp: &str,
        provider: Provider,
    ) -> Result<Option<ConnectionLease>> {
        self.collector(dsp, provider)?.one_as(
            "SELECT enabled,revision FROM connections WHERE provider=?",
            [provider.id()],
        )
    }
    pub fn public_job(&self, row: JobRow) -> Result<PublicJob> {
        let name = self.find_dsp(&row.dsp_id)?.name;
        let metrics = self.metrics(&row.id)?;
        PublicJob::new(row, name, metrics)
    }
    /// `recent_jobs` as JSON, for the integration tests written against it.
    pub fn list_jobs(&self, id: Option<&str>) -> Result<Value> {
        Ok(serde_json::to_value(self.recent_jobs(id)?)?)
    }
    pub fn recent_jobs(&self, id: Option<&str>) -> Result<Vec<PublicJob>> {
        let rows: Vec<JobRow> = match id {
            Some(id) => self.jobs.query_as(RECENT_FOR_DSP, [id])?,
            None => self.jobs.query_as(RECENT, [])?,
        };
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let ids = serde_json::to_string(&rows.iter().map(|r| &r.id).collect::<Vec<_>>())?;
        let dsps = serde_json::to_string(&rows.iter().map(|r| &r.dsp_id).collect::<Vec<_>>())?;
        let names: HashMap<String, String> = self
            .platform
            .query_as::<(String, String)>(DSP_NAMES, [dsps])?
            .into_iter()
            .collect();
        let mut metrics: HashMap<String, Vec<Value>> = HashMap::new();
        for (job, stored) in self.jobs.query_as::<(String, String)>(METRICS, [ids])? {
            metrics
                .entry(job)
                .or_default()
                .push(serde_json::from_str(&stored)?);
        }
        rows.into_iter()
            .map(|row| {
                let name = names
                    .get(&row.dsp_id)
                    .ok_or_else(|| Error::new("dsp_not_found", 404))?;
                let metrics = metrics.remove(&row.id).unwrap_or_default();
                PublicJob::new(row, name.clone(), metrics)
            })
            .collect()
    }
    pub fn job_row(&self, id: &str, dsp: Option<&str>) -> Result<JobRow> {
        self.jobs
            .one_as(JOB, params![id, dsp, dsp])?
            .ok_or_else(|| Error::new("job_not_found", 404))
    }
    /// The raw row as JSON, for the integration tests written against it.
    pub fn job(&self, id: &str, dsp: Option<&str>) -> Result<Value> {
        self.jobs
            .one(JOB, params![id, dsp, dsp])?
            .ok_or_else(|| Error::new("job_not_found", 404))
    }
    /// The `enqueue_*` functions answer with JSON, for the integration tests written against them.
    pub fn enqueue(&self, id: &str, actor: Option<&str>, key: &str) -> Result<Value> {
        self.enqueue_for(id, actor, key, Provider::Paycom, &json!({}))
    }
    pub fn enqueue_paycom_date(
        &self,
        id: &str,
        actor: Option<&str>,
        key: &str,
        date: &str,
    ) -> Result<Value> {
        let request = json!({"date":date});
        crate::workforce::collection_date(&request, &self.find_dsp(id)?.timezone)?;
        self.enqueue_for(id, actor, key, Provider::Paycom, &request)
    }
    pub fn enqueue_meals(
        &self,
        id: &str,
        actor: Option<&str>,
        key: &str,
        scope: &crate::meals::Scope,
    ) -> Result<Value> {
        scope.validate()?;
        self.enqueue_for(
            id,
            actor,
            key,
            Provider::Cortex,
            &serde_json::to_value(scope)?,
        )
    }
    fn enqueue_for(
        &self,
        id: &str,
        actor: Option<&str>,
        key: &str,
        provider: Provider,
        request: &Value,
    ) -> Result<Value> {
        let job = self
            .enqueue_batch(id, actor, &[(key.into(), provider, request.clone())])?
            .remove(0);
        Ok(serde_json::to_value(job)?)
    }
    pub(crate) fn enqueue_batch(
        &self,
        id: &str,
        actor: Option<&str>,
        requests: &[(String, Provider, Value)],
    ) -> Result<Vec<PublicJob>> {
        self.ensure_dsp_active(id)?;
        let connections = requests
            .iter()
            .map(|(_, provider, _)| {
                let connection = self.connection_lease(id, *provider)?.unwrap();
                ensure(connection.enabled, "connection_required", 409)?;
                Ok(connection)
            })
            .collect::<Result<Vec<_>>>()?;
        self.jobs.transaction(|| {
            let queued = requests.iter().zip(&connections);
            queued
                .map(|((key, provider, request), connection)| {
                    let existing: Option<JobRow> = self.jobs.one_as(
                        "SELECT * FROM jobs WHERE dsp_id=? AND idempotency_key=?",
                        [id, key],
                    )?;
                    if let Some(row) = existing {
                        ensure(
                            row.provider() == *provider
                                && serde_json::from_str::<Value>(&row.request)? == *request,
                            "idempotency_conflict",
                            409,
                        )?;
                        return self.public_job(row);
                    }
                    ensure(self.jobs.count(ACTIVE_COUNT, [id])? < 5, "queue_full", 429)?;
                    let job = crypto::id("job")?;
                    self.jobs.exec(
                        INSERT,
                        params![
                            job,
                            id,
                            self.config.environment,
                            provider.job_kind(),
                            now(),
                            iso(),
                            self.config.release,
                            actor,
                            connection.revision,
                            key,
                            serde_json::to_string(request)?
                        ],
                    )?;
                    self.public_job(self.job_row(&job, None)?)
                })
                .collect()
        })
    }
    /// Cancels the unfinished jobs the filter names; a finished job is left as it ended.
    pub fn cancel_jobs(&self, filter: CancelJobs<'_>) -> Result<usize> {
        let (at, kind);
        let (scope, values): (&str, Vec<&dyn rusqlite::ToSql>) = match &filter {
            CancelJobs::Job { id, dsp } => (" AND id=? AND dsp_id=?", vec![id, dsp]),
            CancelJobs::Provider { dsp, provider } => {
                kind = provider.job_kind();
                (" AND dsp_id=? AND kind=?", vec![dsp, &kind])
            }
            CancelJobs::Dsp(dsp) => (" AND dsp_id=?", vec![dsp]),
        };
        at = iso();
        let mut bound: Vec<&dyn rusqlite::ToSql> = vec![&at];
        bound.extend(values);
        self.jobs
            .exec(&format!("{CANCEL}{scope}"), bound.as_slice())
    }
    pub fn cancel_job(&self, id: &str, dsp: &str) -> Result<Value> {
        Ok(serde_json::to_value(self.cancel(id, dsp)?)?)
    }
    pub fn cancel(&self, id: &str, dsp: &str) -> Result<PublicJob> {
        let row = self.job_row(id, Some(dsp))?;
        self.cancel_jobs(CancelJobs::Job { id, dsp })?;
        let provider = row.provider();
        provider.collector().discard(self, dsp, Some(id))?;
        self.clear_live(dsp, provider, Some(id))?;
        self.public_job(self.job_row(id, Some(dsp))?)
    }
    pub fn cancel_provider(&self, id: &str, provider: Provider) -> Result<()> {
        self.clear_live(id, provider, None)?;
        self.cancel_jobs(CancelJobs::Provider { dsp: id, provider })?;
        provider.collector().discard(self, id, None)
    }
    pub fn cancel_dsp(&self, id: &str) -> Result<()> {
        for provider in Provider::ALL {
            self.clear_live(id, *provider, None)?;
        }
        for provider in Provider::ALL {
            provider.collector().discard(self, id, None)?;
        }
        self.cancel_jobs(CancelJobs::Dsp(id))?;
        Ok(())
    }
    /// The job is still this worker's to run. Answers with its DSP.
    pub fn guard(&self, id: &str, owner: &str) -> Result<Dsp> {
        let row = self.job_row(id, None)?;
        ensure(
            row.held_by(owner) && row.lease_until.unwrap_or(0) > now(),
            "job_cancelled",
            409,
        )?;
        let dsp = self.ensure_dsp_active(&row.dsp_id)?;
        if let Some(actor) = row.actor_id.as_deref() {
            let user: (UserStatus, bool) = self
                .platform
                .one_as(
                    "SELECT status,platform_owner FROM users WHERE id=?",
                    [actor],
                )?
                .ok_or_else(|| Error::new("permission_denied", 403))?;
            let (status, platform_owner) = user;
            ensure(
                status == UserStatus::Active
                    && (platform_owner
                        || self.grant(actor, &row.dsp_id)?.is_some_and(|grant| {
                            grant.owner || grant.permissions.iter().any(|p| p == "collections.run")
                        })),
                "permission_denied",
                403,
            )?;
        }
        let connection = self
            .connection_lease(&row.dsp_id, row.provider())?
            .ok_or_else(|| Error::new("connection_required", 409))?;
        ensure(
            connection.enabled && connection.revision == row.connection_revision,
            "connection_changed",
            409,
        )?;
        Ok(dsp)
    }
    /// `guard` answering with JSON, for the integration tests written against it.
    pub fn guard_job(&self, id: &str, owner: &str) -> Result<Value> {
        Ok(serde_json::to_value(self.guard(id, owner)?)?)
    }
    pub fn recover_jobs(&self, all: bool) -> Result<()> {
        self.jobs.transaction(|| {
            if all {
                self.jobs.exec(CANCEL_RUNNING_METRICS, [iso()])?;
            }
            self.jobs
                .exec(INTERRUPT_METRICS, params![iso(), all, now()])?;
            self.jobs.exec(RECOVER, params![now(), iso(), all, now()])?;
            Ok(())
        })
    }
    /// The next job a worker may run, now leased to `owner`.
    pub fn claim_job(
        &self,
        owner: &str,
        eligible: impl Fn(&str, Provider) -> bool,
    ) -> Result<Option<JobRow>> {
        self.jobs.transaction(|| {
            if self.jobs.count(LEASED_COUNT, [])? >= self.config.browser_capacity as i64 {
                return Ok(None);
            }
            // A kind no registered provider runs is not a job this release can claim.
            let queued: Vec<Claimable> = self.jobs.query_as(CLAIMABLE, [now()])?;
            let Some(Claimable { id, .. }) = queued.into_iter().find(|job| {
                Provider::from_job_kind(&job.kind).is_ok_and(|p| eligible(&job.dsp_id, p))
            }) else {
                return Ok(None);
            };
            self.jobs
                .exec(START, params![iso(), owner, now() + 120000, id])?;
            let job = self.job_row(&id, None)?;
            self.jobs.exec(
                "INSERT INTO job_metrics(job_id,attempt,owner,metrics) VALUES (?,?,?,?)",
                params![
                    job.id,
                    job.attempt,
                    owner,
                    serde_json::to_string(&Metrics::start(&job))?
                ],
            )?;
            Ok(Some(job))
        })
    }
    /// `claim_job` as the raw row in JSON, for the integration tests written against it.
    pub fn claim(
        &self,
        owner: &str,
        eligible: impl Fn(&str, Provider) -> bool,
    ) -> Result<Option<Value>> {
        let Some(job) = self.claim_job(owner, eligible)? else {
            return Ok(None);
        };
        Ok(Some(self.job(&job.id, None)?))
    }
    pub fn progress(
        &self,
        id: &str,
        owner: &str,
        progress: i64,
        message: &str,
        status: ActiveJobStatus,
    ) -> Result<()> {
        let count = self.jobs.exec(
            PROGRESS,
            params![progress.clamp(0, 99), message, status.as_str(), id, owner],
        )?;
        ensure(count == 1, "job_cancelled", 409)
    }
    pub fn finish(&self, id: &str, owner: &str, error: Option<&str>) -> Result<()> {
        let row = self.job_row(id, None)?;
        if !row.held_by(owner) {
            return Ok(());
        }
        let retry = error.is_some_and(|e| Code::text_is_any(e, Code::RETRYABLE))
            && row.attempt < row.max_attempts;
        let (status, message) = if retry {
            (JobStatus::Queued, "Retry scheduled")
        } else if error.is_some() {
            (JobStatus::Failed, "Collection could not finish")
        } else {
            (JobStatus::Succeeded, "Collection completed")
        };
        self.jobs.exec(
            FINISH,
            params![
                status,
                if error.is_some() { row.progress } else { 100 },
                message,
                error,
                if retry { None } else { Some(iso()) },
                now() + retry_delay(id, row.attempt),
                id
            ],
        )?;
        let provider = row.provider();
        self.clear_live(&row.dsp_id, provider, Some(id))?;
        if !retry {
            provider.collector().discard(self, &row.dsp_id, Some(id))?;
        }
        Ok(())
    }
    /// `job_facts` for a job given as its raw row in JSON, as the integration tests give it.
    pub fn outcome_facts(&self, dsp: &str, job: &Value) -> (Option<String>, Vec<AuditChange>) {
        use crate::db::{n, s};
        self.job_facts(
            dsp,
            &JobFacts {
                idempotency_key: s(job, "idempotency_key"),
                provider: Provider::from_job_kind(s(job, "kind")).ok(),
                attempt: n(job, "attempt"),
                max_attempts: n(job, "max_attempts"),
                request: s(job, "request"),
                started_at: job["started_at"].as_str(),
            },
        )
    }
    // What an outcome's log entry says beyond pass or fail: the schedule that
    // queued it, and the provider, collected date and run time.
    pub fn job_facts(&self, dsp: &str, job: &JobFacts<'_>) -> (Option<String>, Vec<AuditChange>) {
        let schedule = job
            .idempotency_key
            .strip_prefix("schedule:")
            .and_then(|key| key.split(':').next())
            .and_then(|id| self.collection_schedule(dsp, id).ok())
            .map(|row| row.name);
        // Only a registered kind is ever claimed, so a job always names its provider.
        let provider = job.provider.map_or("", Provider::id);
        let mut facts = vec![("provider", None, Some(provider.to_owned()))];
        if job.attempt > 1 || job.max_attempts > 1 {
            facts.push((
                "attempt",
                None,
                Some(format!("{} of {}", job.attempt, job.max_attempts)),
            ));
        }
        let request = serde_json::from_str::<Value>(job.request).unwrap_or_default();
        if let Some(date) = request["date"].as_str() {
            facts.push(("date", None, Some(date.to_owned())));
        }
        if let Some(started) = job
            .started_at
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        {
            let seconds = (now() - started.timestamp_millis()).max(0) / 1000;
            facts.push(("duration", None, Some(seconds.to_string())));
        }
        (schedule, facts)
    }
}
// Stable per-job jitter survives restarts and disperses DSP retries. No secret
// material or provider identity participates in the delay.
fn retry_delay(id: &str, attempt: i64) -> i64 {
    use sha2::{Digest, Sha256};
    let base = 30000 * 2_i64.pow(attempt.clamp(0, 8) as u32);
    let digest = Sha256::digest(format!("{id}:{attempt}"));
    base + i64::from(u32::from_le_bytes(digest[..4].try_into().unwrap())) % (base / 2 + 1)
}

#[cfg(test)]
mod retry_tests {
    use super::*;
    #[test]
    fn retries_are_bounded_staggered_and_stable() {
        let values = (0..100)
            .map(|i| retry_delay(&format!("job-{i}"), 1))
            .collect::<std::collections::HashSet<_>>();
        assert!(values.len() > 90);
        assert!(values.iter().all(|delay| (60000..=90000).contains(delay)));
        let delay = retry_delay("job-test", 2);
        assert!((120000..=180000).contains(&delay));
        assert_eq!(delay, retry_delay("job-test", 2));
    }
}
