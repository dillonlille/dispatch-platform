use crate::collectors::Provider;
use crate::{
    Error, Result,
    contracts::{ActiveJobStatus, PublicJob},
    crypto,
    db::{AuditChange, Store, flag, iso, n, now, s},
    ensure,
    job_metrics::Metrics,
};
use rusqlite::params;
use serde_json::{Value, json};
use std::collections::HashMap;
fn public_job(row: &Value, name: &Value, metrics: Vec<Value>) -> Result<Value> {
    Ok(serde_json::to_value(PublicJob::from_row(
        row, name, metrics,
    )?)?)
}
impl Store {
    pub fn public_job(&self, row: &Value) -> Result<Value> {
        public_job(
            row,
            &self.get_dsp(s(row, "dsp_id"))?["name"],
            self.metrics(s(row, "id"))?,
        )
    }
    pub fn list_jobs(&self, id: Option<&str>) -> Result<Value> {
        let rows = match id {
            Some(id) => self.jobs.all(
                "SELECT * FROM jobs WHERE dsp_id=? ORDER BY created_at DESC LIMIT 200",
                [id],
            )?,
            None => self
                .jobs
                .all("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200", [])?,
        };
        if rows.is_empty() {
            return Ok(json!([]));
        }
        let ids = serde_json::to_string(&rows.iter().map(|r| s(r, "id")).collect::<Vec<_>>())?;
        let dsps = serde_json::to_string(&rows.iter().map(|r| s(r, "dsp_id")).collect::<Vec<_>>())?;
        let names: HashMap<String, Value> = self
            .platform
            .all(
                "SELECT id,name FROM dsps WHERE id IN (SELECT value FROM json_each(?))",
                [dsps],
            )?
            .into_iter()
            .map(|r| (s(&r, "id").to_owned(), r["name"].clone()))
            .collect();
        let mut metrics: HashMap<String, Vec<Value>> = HashMap::new();
        for row in self.jobs.all("SELECT job_id,metrics FROM job_metrics WHERE job_id IN (SELECT value FROM json_each(?)) ORDER BY attempt", [ids])? {
            metrics.entry(s(&row,"job_id").to_owned()).or_default().push(serde_json::from_str(s(&row,"metrics"))?);
        }
        Ok(json!(
            rows.iter()
                .map(|row| {
                    let name = names
                        .get(s(row, "dsp_id"))
                        .ok_or_else(|| Error::new("dsp_not_found", 404))?;
                    public_job(row, name, metrics.remove(s(row, "id")).unwrap_or_default())
                })
                .collect::<Result<Vec<_>>>()?
        ))
    }
    pub fn job(&self, id: &str, dsp: Option<&str>) -> Result<Value> {
        self.jobs
            .one(
                "SELECT * FROM jobs WHERE id=? AND (? IS NULL OR dsp_id=?)",
                params![id, dsp, dsp],
            )?
            .ok_or_else(|| Error::new("job_not_found", 404))
    }
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
        crate::workforce::collection_date(&request, s(&self.get_dsp(id)?, "timezone"))?;
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
        Ok(self
            .enqueue_batch(id, actor, &[(key.into(), provider, request.clone())])?
            .remove(0))
    }
    pub(crate) fn enqueue_batch(
        &self,
        id: &str,
        actor: Option<&str>,
        requests: &[(String, Provider, Value)],
    ) -> Result<Vec<Value>> {
        let dsp = self.get_dsp(id)?;
        ensure(
            s(&dsp, "status") == "active" && s(&dsp, "environment") == self.config.environment,
            "dsp_unavailable",
            409,
        )?;
        let connections = requests
            .iter()
            .map(|(_, provider, _)| {
                let connection = self
                    .collector(id, *provider)?
                    .one(
                        "SELECT enabled,revision FROM connections WHERE provider=?",
                        [provider.id()],
                    )?
                    .unwrap();
                ensure(flag(&connection, "enabled"), "connection_required", 409)?;
                Ok(connection)
            })
            .collect::<Result<Vec<_>>>()?;
        self.jobs.transaction(|| requests.iter().zip(&connections).map(|((key,provider,request),connection)| {
            if let Some(row)=self.jobs.one("SELECT * FROM jobs WHERE dsp_id=? AND idempotency_key=?",[id,key])? {ensure(s(&row,"kind")==provider.job_kind() && serde_json::from_str::<Value>(s(&row,"request"))? == *request,"idempotency_conflict",409)?;return self.public_job(&row);}
            ensure(n(&self.jobs.one("SELECT count(*) count FROM jobs WHERE dsp_id=? AND status IN ('queued','running','waiting_verification')",[id])?.unwrap(),"count")<5,"queue_full",429)?;
            let job=crypto::id("job")?;
            self.jobs.exec("INSERT INTO jobs(id,dsp_id,environment,kind,status,available_at,created_at,release,actor_id,connection_revision,idempotency_key,request) VALUES (?,?,?,?,'queued',?,?,?,?,?,?,?)",params![job,id,self.config.environment,provider.job_kind(),now(),iso(),self.config.release,actor,n(connection,"revision"),key,serde_json::to_string(request)?])?;
            self.public_job(&self.job(&job,None)?)
        }).collect())
    }
    pub fn cancel_job(&self, id: &str, dsp: &str) -> Result<Value> {
        let row = self.job(id, Some(dsp))?;
        self.jobs.exec("UPDATE jobs SET status='cancelled',message='Cancelled',completed_at=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND dsp_id=? AND status IN ('queued','running','waiting_verification')",[&iso(),id,dsp])?;
        let provider = Provider::from_job_kind(s(&row, "kind"))?;
        provider.collector().discard(self, dsp, Some(id))?;
        self.clear_live(dsp, provider, Some(id))?;
        self.public_job(&self.job(id, Some(dsp))?)
    }
    pub fn cancel_provider(&self, id: &str, provider: Provider) -> Result<()> {
        self.clear_live(id, provider, None)?;
        self.jobs.exec("UPDATE jobs SET status='cancelled',message='Cancelled',completed_at=?,lease_owner=NULL,lease_until=NULL WHERE dsp_id=? AND kind=? AND status IN ('queued','running','waiting_verification')",params![iso(),id,provider.job_kind()])?;
        provider.collector().discard(self, id, None)
    }
    pub fn cancel_dsp(&self, id: &str) -> Result<()> {
        for provider in Provider::ALL {
            self.clear_live(id, *provider, None)?;
        }
        for provider in Provider::ALL {
            provider.collector().discard(self, id, None)?;
        }
        self.jobs.exec("UPDATE jobs SET status='cancelled',message='Cancelled',completed_at=?,lease_owner=NULL,lease_until=NULL WHERE dsp_id=? AND status IN ('queued','running','waiting_verification')",[&iso(),id])?;
        Ok(())
    }
    pub fn guard_job(&self, id: &str, owner: &str) -> Result<Value> {
        let row = self.job(id, None)?;
        ensure(
            s(&row, "lease_owner") == owner
                && ["running", "waiting_verification"].contains(&s(&row, "status"))
                && n(&row, "lease_until") > now(),
            "job_cancelled",
            409,
        )?;
        let dsp = self.get_dsp(s(&row, "dsp_id"))?;
        ensure(
            s(&dsp, "status") == "active" && s(&dsp, "environment") == self.config.environment,
            "dsp_unavailable",
            409,
        )?;
        if let Some(actor) = row["actor_id"].as_str() {
            let user = self
                .platform
                .one(
                    "SELECT status,platform_owner FROM users WHERE id=?",
                    [actor],
                )?
                .ok_or_else(|| Error::new("permission_denied", 403))?;
            ensure(
                s(&user, "status") == "active"
                    && (flag(&user, "platform_owner")
                        || self.grant(actor, s(&row, "dsp_id"))?.is_some_and(|grant| {
                            grant.owner || grant.permissions.iter().any(|p| p == "collections.run")
                        })),
                "permission_denied",
                403,
            )?;
        }
        let provider = Provider::from_job_kind(s(&row, "kind"))?;
        let connection = self
            .collector(s(&row, "dsp_id"), provider)?
            .one(
                "SELECT enabled,revision FROM connections WHERE provider=?",
                [provider.id()],
            )?
            .ok_or_else(|| Error::new("connection_required", 409))?;
        ensure(
            flag(&connection, "enabled") && connection["revision"] == row["connection_revision"],
            "connection_changed",
            409,
        )?;
        Ok(dsp)
    }
    pub fn recover_jobs(&self, all: bool) -> Result<()> {
        self.jobs.transaction(|| {
            if all {
                self.jobs.exec("UPDATE job_metrics SET owner='',metrics=json_set(metrics,'$.outcome','cancelled','$.error','job_cancelled','$.phase',NULL,'$.finishedAt',?) WHERE json_extract(metrics,'$.outcome')='running' AND job_id IN (SELECT id FROM jobs WHERE status='cancelled')",[iso()])?;
            }
            self.jobs.exec("UPDATE job_metrics SET owner='',metrics=json_set(metrics,'$.outcome','interrupted','$.error','worker_interrupted','$.phase',NULL,'$.finishedAt',?) WHERE json_extract(metrics,'$.outcome')='running' AND job_id IN (SELECT id FROM jobs WHERE status IN ('running','waiting_verification') AND (? OR lease_until<?))",params![iso(),all,now()])?;
            self.jobs.exec("UPDATE jobs SET status=CASE WHEN attempt>=max_attempts THEN 'failed' ELSE 'queued' END,message='Recovered interrupted collection',error='worker_interrupted',available_at=?,completed_at=CASE WHEN attempt>=max_attempts THEN ? ELSE NULL END,lease_owner=NULL,lease_until=NULL WHERE status IN ('running','waiting_verification') AND (? OR lease_until<?)",params![now(),iso(),all,now()])?;
            Ok(())
        })
    }
    pub fn claim(
        &self,
        owner: &str,
        eligible: impl Fn(&str, Provider) -> bool,
    ) -> Result<Option<Value>> {
        self.jobs.transaction(|| {
            if n(&self.jobs.one("SELECT count(*) n FROM jobs WHERE status IN ('running','waiting_verification')",[])?.unwrap(),"n")>=self.config.browser_capacity as i64 {return Ok(None);}
            let rows=self.jobs.all("SELECT * FROM jobs j WHERE j.status='queued' AND j.available_at<=? AND NOT EXISTS (SELECT 1 FROM jobs active WHERE active.dsp_id=j.dsp_id AND active.status IN ('running','waiting_verification')) ORDER BY (SELECT COALESCE(MAX(completed_at),'') FROM jobs previous WHERE previous.dsp_id=j.dsp_id),j.created_at LIMIT 200",[now()])?;
            let Some(row)=rows.into_iter().find(|r|Provider::from_job_kind(s(r,"kind")).is_ok_and(|p|eligible(s(r,"dsp_id"),p))) else {return Ok(None);};
            self.jobs.exec("UPDATE jobs SET status='running',attempt=attempt+1,started_at=?,lease_owner=?,lease_until=?,message='Starting collection' WHERE id=?",params![iso(),owner,now()+120000,s(&row,"id")])?;
            let job=self.job(s(&row,"id"),None)?;
            self.jobs.exec("INSERT INTO job_metrics(job_id,attempt,owner,metrics) VALUES (?,?,?,?)",params![s(&job,"id"),n(&job,"attempt"),owner,serde_json::to_string(&Metrics::new(&job))?])?;
            Ok(Some(job))
        })
    }
    pub fn progress(
        &self,
        id: &str,
        owner: &str,
        progress: i64,
        message: &str,
        status: ActiveJobStatus,
    ) -> Result<()> {
        let count=self.jobs.exec("UPDATE jobs SET progress=?,message=?,status=? WHERE id=? AND lease_owner=? AND status IN ('running','waiting_verification')",params![progress.clamp(0,99),message,status.as_str(),id,owner])?;
        ensure(count == 1, "job_cancelled", 409)
    }
    pub fn finish(&self, id: &str, owner: &str, error: Option<&str>) -> Result<()> {
        let row = self.job(id, None)?;
        if s(&row, "lease_owner") != owner
            || !["running", "waiting_verification"].contains(&s(&row, "status"))
        {
            return Ok(());
        }
        let retry = error.is_some_and(|e| {
            [
                "browser_lost",
                "browser_closed",
                "browser_command_timeout",
                "provider_timeout",
                "provider_unavailable",
                "provider_navigation_timeout",
                "provider_content_timeout",
                "cortex_source_changed",
                "cortex_content_incomplete",
            ]
            .contains(&e)
        }) && n(&row, "attempt") < n(&row, "max_attempts");
        self.jobs.exec("UPDATE jobs SET status=?,progress=?,message=?,error=?,completed_at=?,available_at=?,lease_owner=NULL,lease_until=NULL WHERE id=?",params![if retry{"queued"}else if error.is_some(){"failed"}else{"succeeded"},if error.is_some(){n(&row,"progress")}else{100},if retry{"Retry scheduled"}else if error.is_some(){"Collection could not finish"}else{"Collection completed"},error,if retry{None}else{Some(iso())},now()+retry_delay(id,n(&row,"attempt")),id])?;
        let provider = Provider::from_job_kind(s(&row, "kind"))?;
        self.clear_live(s(&row, "dsp_id"), provider, Some(id))?;
        if !retry {
            provider
                .collector()
                .discard(self, s(&row, "dsp_id"), Some(id))?;
        }
        Ok(())
    }
    // What an outcome's log entry says beyond pass or fail: the schedule that
    // queued it, and the provider, collected date and run time.
    pub fn outcome_facts(&self, dsp: &str, job: &Value) -> (Option<String>, Vec<AuditChange>) {
        let schedule = s(job, "idempotency_key")
            .strip_prefix("schedule:")
            .and_then(|key| key.split(':').next())
            .and_then(|id| self.collection_schedule(dsp, id).ok())
            .map(|row| s(&row, "name").to_owned());
        // Only a registered kind is ever claimed, so a job always names its provider.
        let provider = Provider::from_job_kind(s(job, "kind")).map_or("", Provider::id);
        let mut facts = vec![("provider", None, Some(provider.to_owned()))];
        if n(job, "attempt") > 1 || n(job, "max_attempts") > 1 {
            facts.push((
                "attempt",
                None,
                Some(format!(
                    "{} of {}",
                    n(job, "attempt"),
                    n(job, "max_attempts")
                )),
            ));
        }
        let request = serde_json::from_str::<Value>(s(job, "request")).unwrap_or_default();
        if let Some(date) = request["date"].as_str() {
            facts.push(("date", None, Some(date.to_owned())));
        }
        if let Some(started) = job["started_at"]
            .as_str()
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
