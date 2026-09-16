use super::collectors::Provider;
use super::{
    Error, Result, State, crypto,
    db::{Store, at, flag, iso, n, now, s},
    ensure,
    job_metrics::{self, Metrics, Phase, Recorder},
};
use rusqlite::params;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
// Preserve the original user_version so the prior runtime can still operate Paycom
// after rollback. The new request column has a default for its old INSERTs.
pub(crate) fn migrate(db: &super::db::Db) -> Result<()> {
    let columns = db.all("PRAGMA table_info(jobs)", [])?;
    if columns.iter().any(|c| s(c, "name") == "request") {
        return Ok(());
    }
    db.0.execute_batch("PRAGMA foreign_keys=OFF")?;
    let result=db.transaction(|| {
        let schema=include_str!("jobSchema.sql");
        let (table,indexes)=schema.split_once('\n').unwrap();
        db.0.execute_batch(&table.replacen("CREATE TABLE jobs ","CREATE TABLE jobs_next ",1))?;
        let names=columns.iter().map(|c|s(c,"name")).collect::<Vec<_>>().join(",");
        db.0.execute_batch(&format!("INSERT INTO jobs_next ({names}) SELECT {names} FROM jobs; DROP TABLE jobs; ALTER TABLE jobs_next RENAME TO jobs; {indexes}"))?;
        ensure(db.all("PRAGMA foreign_key_check",[])?.is_empty(),"invalid_job_migration",503)
    });
    db.0.execute_batch("PRAGMA foreign_keys=ON")?;
    result
}
impl Store {
    pub fn public_job(&self, row: &Value) -> Result<Value> {
        Ok(
            json!({"id":row["id"],"dspId":row["dsp_id"],"dspName":self.get_dsp(s(row,"dsp_id"))?["name"],"environment":row["environment"],"kind":row["kind"],"status":row["status"],"progress":row["progress"],"message":row["message"],"attempt":row["attempt"],"maxAttempts":row["max_attempts"],"availableAt":at(n(row,"available_at")),"createdAt":row["created_at"],"startedAt":row["started_at"],"completedAt":row["completed_at"],"error":row["error"],"release":row["release"],"actorId":row["actor_id"],"metrics":self.metrics(s(row,"id"))?}),
        )
    }
    pub fn list_jobs(&self, id: Option<&str>) -> Result<Value> {
        let rows = self.jobs.all(
            "SELECT * FROM jobs WHERE (? IS NULL OR dsp_id=?) ORDER BY created_at DESC LIMIT 200",
            params![id, id],
        )?;
        Ok(json!(
            rows.iter()
                .map(|r| self.public_job(r))
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
    pub fn enqueue_meals(
        &self,
        id: &str,
        actor: Option<&str>,
        key: &str,
        scope: &super::meals::Scope,
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
        let dsp = self.get_dsp(id)?;
        ensure(
            s(&dsp, "status") == "active" && s(&dsp, "environment") == self.config.environment,
            "dsp_unavailable",
            409,
        )?;
        let connection = self
            .collector(id, provider)?
            .one(
                "SELECT enabled,revision FROM connections WHERE provider=?",
                [provider.id()],
            )?
            .unwrap();
        ensure(flag(&connection, "enabled"), "connection_required", 409)?;
        self.jobs.transaction(||{
            if let Some(row)=self.jobs.one("SELECT * FROM jobs WHERE dsp_id=? AND idempotency_key=?",[id,key])? {ensure(s(&row,"kind")==provider.job_kind().unwrap() && serde_json::from_str::<Value>(s(&row,"request"))? == *request,"idempotency_conflict",409)?;return self.public_job(&row);}
            ensure(n(&self.jobs.one("SELECT count(*) count FROM jobs WHERE dsp_id=? AND status IN ('queued','running','waiting_verification')",[id])?.unwrap(),"count")<5,"queue_full",429)?;
            let job=crypto::id("job")?;
            self.jobs.exec("INSERT INTO jobs(id,dsp_id,environment,kind,status,available_at,created_at,release,actor_id,connection_revision,idempotency_key,request) VALUES (?,?,?,?,'queued',?,?,?,?,?,?,?)",params![job,id,self.config.environment,provider.job_kind(),now(),iso(),self.config.release,actor,n(&connection,"revision"),key,serde_json::to_string(request)?])?;
            self.public_job(&self.job(&job,None)?)
        })
    }
    pub fn cancel_job(&self, id: &str, dsp: &str) -> Result<Value> {
        let row = self.job(id, Some(dsp))?;
        self.jobs.exec("UPDATE jobs SET status='cancelled',message='Cancelled',completed_at=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND dsp_id=? AND status IN ('queued','running','waiting_verification')",[&iso(),id,dsp])?;
        if s(&row, "kind") == "paycom.collect" {
            self.clear_checkpoint(dsp, Some(id))?;
        }
        self.public_job(&self.job(id, Some(dsp))?)
    }
    pub fn cancel_provider(&self, id: &str, provider: Provider) -> Result<()> {
        self.jobs.exec("UPDATE jobs SET status='cancelled',message='Cancelled',completed_at=?,lease_owner=NULL,lease_until=NULL WHERE dsp_id=? AND kind=? AND status IN ('queued','running','waiting_verification')",params![iso(),id,provider.job_kind()])?;
        if provider == Provider::Paycom {
            self.clear_checkpoint(id, None)?;
        }
        Ok(())
    }
    pub fn cancel_dsp(&self, id: &str) -> Result<()> {
        self.clear_checkpoint(id, None)?;
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
            let user=self.platform.one("SELECT u.status,u.platform_owner,m.role FROM users u LEFT JOIN memberships m ON m.user_id=u.id AND m.dsp_id=? WHERE u.id=?",[s(&row,"dsp_id"),actor])?.ok_or_else(||Error::new("permission_denied",403))?;
            ensure(
                s(&user, "status") == "active"
                    && (flag(&user, "platform_owner")
                        || ["owner", "manager"].contains(&s(&user, "role"))),
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
        status: &str,
    ) -> Result<()> {
        let count=self.jobs.exec("UPDATE jobs SET progress=?,message=?,status=? WHERE id=? AND lease_owner=? AND status IN ('running','waiting_verification')",params![progress.clamp(0,99),message,status,id,owner])?;
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
        if !retry && s(&row, "kind") == "paycom.collect" {
            self.clear_checkpoint(s(&row, "dsp_id"), Some(id))?;
        }
        Ok(())
    }
    pub fn schedule(&self, id: &str) -> Result<Value> {
        let db = self.collector(id, Provider::Paycom)?;
        let r = db
            .one("SELECT * FROM schedules WHERE provider='paycom'", [])?
            .unwrap();
        let mut value = json!({"enabled":flag(&r,"enabled"),"localTime":r["local_time"],"timezone":r["timezone"],"nextRun":r["next_run"]});
        let interval = db.setting("paycom.syncIntervalSeconds", Value::Null)?;
        if !interval.is_null() {
            value["intervalSeconds"] = interval;
        }
        Ok(value)
    }
    pub fn set_schedule(&self, id: &str, enabled: bool, time: &str, tz: &str) -> Result<Value> {
        let next = next_occurrence(time, tz, now())?;
        let db = self.collector(id, Provider::Paycom)?;
        db.transaction(||{db.exec("DELETE FROM settings WHERE key='paycom.syncIntervalSeconds'",[])?;db.exec("UPDATE schedules SET enabled=?,local_time=?,timezone=?,next_run=? WHERE provider='paycom'",params![enabled,time,tz,if enabled{Some(next)}else{None}])?;Ok(())})?;
        self.schedule(id)
    }
    pub fn schedule_tick(&self) -> Result<()> {
        for dsp in self.platform.all(
            "SELECT id FROM dsps WHERE status='active' AND environment=?",
            [&self.config.environment],
        )? {
            let id = s(&dsp, "id");
            let schedule = self.schedule(id)?;
            if !flag(&schedule, "enabled") {
                continue;
            }
            let next = if schedule["nextRun"].is_null() {
                let next = next_scheduled(&schedule, now())?;
                self.collector(id, Provider::Paycom)?
                    .exec("UPDATE schedules SET next_run=?", [&next])?;
                next
            } else {
                s(&schedule, "nextRun").to_owned()
            };
            if next > iso() {
                continue;
            }
            if self.enqueue(id, None, &format!("schedule:{next}")).is_ok() {
                self.collector(id, Provider::Paycom)?.exec(
                    "UPDATE schedules SET next_run=?",
                    [next_scheduled(&schedule, now())?],
                )?;
            }
        }
        Ok(())
    }
}
pub fn next_occurrence(time: &str, tz: &str, after: i64) -> Result<String> {
    ensure(
        time.len() == 5 && chrono::NaiveTime::parse_from_str(time, "%H:%M").is_ok(),
        "invalid_schedule_time",
        400,
    )?;
    let tz: chrono_tz::Tz = tz
        .parse()
        .map_err(|_| Error::new("invalid_timezone", 400))?;
    let start = after / 60000 * 60000 + 60000;
    for minute in 0..3 * 24 * 60 {
        let ms = start + minute * 60000;
        let instant = chrono::DateTime::from_timestamp_millis(ms)
            .ok_or_else(|| Error::new("invalid_schedule", 400))?;
        if instant.with_timezone(&tz).format("%H:%M").to_string() == time {
            return Ok(at(ms));
        }
    }
    Err(Error::new("schedule_unresolvable", 400))
}
fn next_scheduled(schedule: &Value, after: i64) -> Result<String> {
    if n(schedule, "intervalSeconds") > 0 {
        Ok(at(after + n(schedule, "intervalSeconds") * 1000))
    } else {
        next_occurrence(s(schedule, "localTime"), s(schedule, "timezone"), after)
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
pub async fn start(state: Arc<State>, mut stop: tokio::sync::watch::Receiver<bool>) -> Result<()> {
    let owner = crypto::id("worker")?;
    let mut tasks = tokio::task::JoinSet::new();
    let mut running_dsps = std::collections::HashSet::new();
    let mut timer = tokio::time::interval(Duration::from_secs(1));
    let mut checkpoint_cleanup = tokio::time::interval(Duration::from_secs(60));
    loop {
        tokio::select! {
            _=super::cancelled(&mut stop)=>break,
            result=tasks.join_next(),if !tasks.is_empty()=>{
                match result {Some(Ok(dsp))=>{running_dsps.remove(&dsp);},Some(Err(_))=>return Err(Error::new("collector_task_failed",500)),None=>{}}
            },
            _=checkpoint_cleanup.tick()=>{
                let result = state.run(|db| {
                    for dsp in db.platform.all("SELECT id FROM dsps WHERE status IN ('active','suspended')", [])? {
                        db.prune_checkpoints(s(&dsp,"id"))?;
                    }
                    Ok(())
                }).await;
                if let Err(error)=result { eprintln!("checkpoint_cleanup_failed: {}",error.code); }
            },
            _=timer.tick()=>{
                state.expire_browsers().await;
                let result=state.run(|db|{db.recover_jobs(false)?;db.schedule_tick()}).await;
                if let Err(error)=result {eprintln!("scheduler_tick_failed: {}",error.code);}
                while tasks.len()<state.config.browser_capacity {
                    let pool=state.clone();let claim_owner=owner.clone();
                    let running=running_dsps.clone();
                    let job=state.run(move|db| {
                        let memory_ready = (pool.config.fixture && pool.config.fixture_url.is_none()) || pool.browsers.admission().can_start;
                        let message = if memory_ready {"Waiting for a browser"} else {"Waiting for available memory"};
                        db.jobs.exec("UPDATE jobs SET message=?1 WHERE status='queued' AND available_at<=?2 AND message<>?1", params![message,now()])?;
                        db.claim(&claim_owner,|id,provider|!running.contains(id) && pool.browsers.get_for(id,provider).map(|s|!s.busy()&&!s.closed()).unwrap_or_else(||memory_ready && pool.browsers.active()<pool.config.browser_capacity))
                    }).await;
                    match job {Ok(Some(job))=>{let state=state.clone();let owner=owner.clone();let dsp=s(&job,"dsp_id").to_owned();running_dsps.insert(dsp.clone());tasks.spawn(async move{execute(state,job,owner).await;dsp});},Ok(None)=>break,Err(error)=>{eprintln!("job_claim_failed: {}",error.code);break;}}
                }
            }
        }
    }
    state.browsers.close().await;
    while tasks.join_next().await.is_some() {}
    Ok(())
}
async fn execute(state: Arc<State>, job: Value, owner: String) {
    let id = s(&job, "id").to_owned();
    let dsp = s(&job, "dsp_id").to_owned();
    let metrics = Recorder::new(&job);
    let provider = Provider::from_job_kind(s(&job, "kind")).expect("registered job kind");
    let task = async {
        let jid = id.clone();
        let worker = owner.clone();
        state.run(move |db| db.guard_job(&jid, &worker)).await?;
        metrics.phase(Phase::Authentication);
        let session = state.ensure_provider_browser(&dsp, false, provider).await?;
        if session.challenge() {
            metrics.phase(Phase::Verification);
            let jid = id.clone();
            let worker = owner.clone();
            state
                .run(move |db| {
                    db.progress(
                        &jid,
                        &worker,
                        5,
                        "Waiting for owner verification",
                        "waiting_verification",
                    )
                })
                .await?;
            while !session.ready() {
                ensure(!session.closed(), "verification_expired", 409)?;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        let jid = id.clone();
        let worker = owner.clone();
        state
            .run(move |db| {
                db.guard_job(&jid, &worker)?;
                db.progress(
                    &jid,
                    &worker,
                    10,
                    if provider == Provider::Cortex {
                        "Collecting meal breaks"
                    } else {
                        "Collecting workforce"
                    },
                    "running",
                )
            })
            .await?;
        metrics.phase(Phase::Collection);
        let request: Value = serde_json::from_str(s(&job, "request"))?;
        let data = session
            .collect(&state, &id, &owner, &metrics, &request)
            .await?;
        metrics.counts(&data);
        metrics.phase(Phase::Publication);
        let jid = id.clone();
        let worker = owner.clone();
        let tenant = dsp.clone();
        let completed_metrics = metrics.clone();
        state
            .run(move |db| {
                db.guard_job(&jid, &worker)?;
                match provider {
                    Provider::Paycom => db.publish(&tenant, &data)?,
                    Provider::Cortex => db.publish_meals(
                        &tenant,
                        &jid,
                        &serde_json::from_value(data)?,
                        &serde_json::from_value(request)?,
                    )?,
                };
                completed_metrics.finish("succeeded", None);
                db.jobs.transaction(|| {
                    db.save_metrics(&jid, &worker, &completed_metrics.snapshot())?;
                    db.finish(&jid, &worker, None)
                })
            })
            .await
    };
    let mut task = Box::pin(task);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    let mut sample = tokio::time::interval(Duration::from_secs(1));
    sample.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let result = loop {
        tokio::select! {
            result=&mut task=>break result,
            _=sample.tick()=>{
                if let Some(pid)=state.browsers.get_for(&dsp,provider).filter(|session|session.revision==n(&job,"connection_revision")).and_then(|session|session.process_id())
                    && let Ok(Some(memory))=tokio::task::spawn_blocking(move||job_metrics::memory(pid)).await {
                    if let Some(session) = state.browsers.get_for(&dsp,provider) { session.observe_memory(&memory); }
                    metrics.observe(memory);
                }
                let jid=id.clone(); let worker=owner.clone(); let snapshot=metrics.snapshot();
                let _=state.run(move|db|db.save_metrics(&jid,&worker,&snapshot)).await;
            },
            _=heartbeat.tick()=>{
                let jid=id.clone();let worker=owner.clone();
                let guard=state.run(move|db|{db.guard_job(&jid,&worker)?;db.jobs.exec("UPDATE jobs SET lease_until=? WHERE id=? AND lease_owner=?",params![now()+120000,jid,worker])?;Ok(())}).await;
                if let Err(error)=guard{break Err(error);}
            }
        }
    };
    drop(task);
    // A settings-page browser or another just-claimed job may win admission.
    // Put this job back without consuming a provider attempt or retry history.
    if result.as_ref().err().is_some_and(|e| {
        ["browser_memory_busy", "browser_capacity_busy"].contains(&e.code.as_str())
    }) {
        let jid = id.clone();
        let worker = owner.clone();
        let attempt = n(&job, "attempt");
        let deferred=state.run(move |db| db.jobs.transaction(|| {
            let changed=db.jobs.exec("UPDATE jobs SET status='queued',attempt=attempt-1,started_at=NULL,lease_owner=NULL,lease_until=NULL,available_at=?,message='Waiting for browser resources' WHERE id=? AND lease_owner=? AND status='running'",params![now()+5000,jid,worker])?;
            if changed==1 { db.jobs.exec("DELETE FROM job_metrics WHERE job_id=? AND attempt=? AND owner=?",params![jid,attempt,worker])?; }
            Ok(changed==1)
        })).await;
        if matches!(deferred, Ok(true)) {
            return;
        }
    }
    if let Err(error) = &result {
        let jid = id.clone();
        let cancelled = state
            .run(move |db| Ok(s(&db.job(&jid, None)?, "status") == "cancelled"))
            .await
            .unwrap_or(false);
        metrics.finish(
            if cancelled
                || [
                    "job_cancelled",
                    "permission_denied",
                    "connection_changed",
                    "dsp_unavailable",
                ]
                .contains(&error.code.as_str())
            {
                "cancelled"
            } else {
                "failed"
            },
            Some(if cancelled {
                "job_cancelled"
            } else {
                &error.code
            }),
        );
    }
    state
        .browsers
        .revoke_provider_revision(&dsp, n(&job, "connection_revision"), provider)
        .await;
    let error = result.err().map(|e| e.code);
    let actor = job["actor_id"].as_str().map(str::to_owned);
    let snapshot = metrics.snapshot();
    let _ = state
        .run(move |db| {
            if let Some(ref error) = error {
                db.jobs.transaction(|| {
                    db.save_metrics(&id, &owner, &snapshot)?;
                    db.finish(&id, &owner, Some(error))
                })?;
            }
            db.audit(
                actor.as_deref(),
                Some(&dsp),
                if error.is_some() {
                    "collection.failed"
                } else {
                    "collection.completed"
                },
                error.as_deref().unwrap_or(""),
            )
        })
        .await;
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

#[cfg(test)]
mod migration_tests {
    use super::*;
    #[test]
    fn extending_job_kinds_preserves_jobs_metrics_and_legacy_inserts() {
        let db = super::super::db::Db(rusqlite::Connection::open_in_memory().unwrap());
        let old = include_str!("jobSchema.sql")
            .replace(
                "CHECK(kind IN ('paycom.collect','cortex.meal_breaks.collect'))",
                "CHECK(kind='paycom.collect')",
            )
            .replace(" request TEXT NOT NULL DEFAULT '{}',", "");
        db.0.execute_batch(&old).unwrap();
        db.0.execute_batch(include_str!("jobMetricsSchema.sql"))
            .unwrap();
        let insert = "INSERT INTO jobs(id,dsp_id,environment,kind,status,available_at,created_at,release,connection_revision,idempotency_key) VALUES (?,'dsp','preview','paycom.collect','queued',0,'2026','test',1,?)";
        db.exec(insert, ["job-1", "key-1"]).unwrap();
        db.exec(
            "INSERT INTO job_metrics VALUES ('job-1',1,'worker','{}')",
            [],
        )
        .unwrap();
        migrate(&db).unwrap();
        migrate(&db).unwrap();
        assert_eq!(
            db.one("SELECT request FROM jobs WHERE id='job-1'", [])
                .unwrap()
                .unwrap()["request"],
            "{}"
        );
        assert_eq!(db.all("SELECT * FROM job_metrics", []).unwrap().len(), 1);
        db.exec(insert, ["job-2", "key-2"]).unwrap();
        assert!(db.all("PRAGMA foreign_key_check", []).unwrap().is_empty());
        db.exec("DELETE FROM jobs WHERE id='job-1'", []).unwrap();
        assert!(db.all("SELECT * FROM job_metrics", []).unwrap().is_empty());
    }
}
