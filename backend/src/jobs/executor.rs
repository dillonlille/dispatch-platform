use crate::collectors::Provider;
use crate::{
    Error, State,
    contracts::ActiveJobStatus,
    db::{n, now, s},
    ensure,
    job_metrics::{self, Phase, Recorder},
};
use rusqlite::params;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
pub(super) async fn execute(state: Arc<State>, job: Value, owner: String) {
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
                        ActiveJobStatus::WaitingVerification,
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
                    ActiveJobStatus::Running,
                )
            })
            .await?;
        metrics.phase(Phase::Collection);
        let request: Value = serde_json::from_str(s(&job, "request"))?;
        let crate::browsers::Collected { data, scope } = session
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
                        &scope.ok_or_else(|| Error::new("invalid_cortex_scope", 502))?,
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
    // Request logs cannot explain a failed sync; record each attempt's outcome.
    crate::observability::event(
        if error.is_some() { "warn" } else { "info" },
        "job.finished",
        json!({"jobId":id,"dspId":dsp,"kind":s(&job,"kind"),"attempt":n(&job,"attempt"),"error":error,"metrics":job_metrics::summary(&snapshot)}),
    );
    let changed_dsp = dsp.clone();
    let _ = state
        .run(move |db| {
            if let Some(ref error) = error {
                db.jobs.transaction(|| {
                    db.save_metrics(&id, &owner, &snapshot)?;
                    db.finish(&id, &owner, Some(error))
                })?;
            }
            // Cancelling is recorded by whoever cancelled; it is not a failure.
            if error.as_deref() == Some("job_cancelled") {
                return Ok(());
            }
            let (schedule, facts) = db.outcome_facts(&dsp, &job);
            // An attempt that will run again is not yet the collection's outcome.
            let retrying = s(&db.job(&id, None)?, "status") == "queued";
            db.audit_ref(
                actor.as_deref(),
                Some(&dsp),
                if retrying {
                    "collection.retrying"
                } else if error.is_some() {
                    "collection.failed"
                } else {
                    "collection.completed"
                },
                error.as_deref().unwrap_or(""),
                schedule.as_deref(),
                &facts,
                Some(("job", &id)),
            )
        })
        .await;
    state.updates.notify(&changed_dsp);
}
