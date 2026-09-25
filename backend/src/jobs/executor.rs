use crate::collectors::Provider;
use crate::{
    State,
    contracts::{ActiveJobStatus, JobRow, JobStatus},
    db::now,
    ensure,
    job_metrics::{self, Phase, Recorder},
};
use rusqlite::params;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
pub(super) async fn execute(state: Arc<State>, job: JobRow, owner: String) {
    let id = job.id.clone();
    let dsp = job.dsp_id.clone();
    let metrics = Recorder::start(&job);
    let provider: Provider = job.provider();
    let task = async {
        let jid = id.clone();
        let worker = owner.clone();
        state
            .run(move |db| db.guard(&jid, &worker).map(|_| ()))
            .await?;
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
        let request: Value = serde_json::from_str(&job.request)?;
        let message = provider.collector().progress(&request);
        state
            .run(move |db| {
                db.guard(&jid, &worker)?;
                db.progress(&jid, &worker, 10, message, ActiveJobStatus::Running)
            })
            .await?;
        metrics.phase(Phase::Collection);
        let collected = session
            .collect(&state, &id, &owner, &metrics, &request, job.attempt)
            .await?;
        metrics.counts(&collected.data);
        metrics.phase(Phase::Publication);
        let jid = id.clone();
        let worker = owner.clone();
        let tenant = dsp.clone();
        let completed_metrics = metrics.clone();
        state
            .run(move |db| {
                db.guard(&jid, &worker)?;
                provider.collector().publish(db, &tenant, &jid, collected)?;
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
                if let Some(session)=state.browsers.get_for(&dsp,
                    provider).filter(|session|session.revision==job.connection_revision)
                    && let Some(pid)=session.process_id() {
                    match tokio::task::spawn_blocking(move||job_metrics::memory(pid).ok_or_else(||
                        !std::path::Path::new(&format!("/proc/{pid}")).exists())).await {
                        Ok(Ok(memory)) => { session.observe_memory(&memory); metrics.observe(memory); }
                        // The driver closed its browser and reads without one.
                        Ok(Err(true)) => session.browser_exited(),
                        _ => {}
                    }
                }
                let jid=id.clone(); let worker=owner.clone(); let snapshot=metrics.snapshot();
                let _=state.run(move|db|db.save_metrics(&jid,&worker,&snapshot)).await;
            },
            _=heartbeat.tick()=>{
                let jid=id.clone();let worker=owner.clone();
                let guard=state.run(move|db|{db.guard(&jid,&worker)?;db.jobs.exec("UPDATE \
                    jobs SET lease_until=? WHERE id=? AND lease_owner=?",params![now()+120000,jid,worker])?;Ok(())}).await;
                if let Err(error)=guard{break Err(error);}
            }
        }
    };
    drop(task);
    // A settings-page browser or another just-claimed job may win admission.
    // Put this job back without consuming a provider attempt or retry history.
    if result
        .as_ref()
        .err()
        .is_some_and(|e| e.is_any(crate::Code::ADMISSION_BUSY))
    {
        let jid = id.clone();
        let worker = owner.clone();
        let attempt = job.attempt;
        let deferred=state.run(move |db| db.jobs.transaction(|| {
            let changed=db.jobs.exec("UPDATE jobs SET \
                status='queued',attempt=attempt-1,started_at=NULL,lease_owner=NULL,lease_until=NULL,\
                available_at=?,message='Waiting for browser resources' WHERE id=? AND lease_owner=? AND \
                status='running'",params![now()+5000,jid,worker])?;
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
            .run(move |db| Ok(db.job_row(&jid, None)?.status == JobStatus::Cancelled))
            .await
            .unwrap_or(false);
        metrics.finish(
            if cancelled || error.is_any(crate::Code::WITHDRAWN) {
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
        .revoke_provider_revision(&dsp, job.connection_revision, provider)
        .await;
    let error = result.err().map(|e| e.code);
    let actor = job.actor_id.clone();
    let snapshot = metrics.snapshot();
    // Request logs cannot explain a failed sync; record each attempt's outcome.
    crate::observability::event(
        if error.is_some() { "warn" } else { "info" },
        "job.finished",
        json!({"jobId":id,"dspId":dsp,"kind":job.kind.as_str(),"attempt":job.attempt,"error":error,
            "metrics":job_metrics::summary(&snapshot)}),
    );
    let changed_dsp = dsp.clone();
    let request: Value = serde_json::from_str(&job.request).unwrap_or_default();
    let change = crate::contracts::CollectionChange {
        provider: provider.id().to_owned(),
        dates: request
            .get("date")
            .and_then(Value::as_str)
            .map(|date| vec![date.to_owned()])
            .unwrap_or_default(),
        employee_code: request
            .get("employeeCode")
            .and_then(Value::as_str)
            .map(str::to_owned),
        roster: provider == Provider::Paycom && request.get("employeeCode").is_none(),
    };
    let _ = state
        .run(move |db| {
            if let Some(ref error) = error {
                db.jobs.transaction(|| {
                    db.save_metrics(&id, &owner, &snapshot)?;
                    db.finish(&id, &owner, Some(error))
                })?;
            }
            // Cancelling is recorded by whoever cancelled; it is not a failure.
            if error
                .as_deref()
                .is_some_and(|e| crate::Code::text_is_any(e, &[crate::Code::JobCancelled]))
            {
                return Ok(());
            }
            let (schedule, facts) = db.job_facts(&dsp, &(&job).into());
            // An attempt that will run again is not yet the collection's outcome.
            let retrying = db.job_row(&id, None)?.status == JobStatus::Queued;
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
    state.updates.changed(&changed_dsp, change);
}
