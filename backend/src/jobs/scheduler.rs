use super::executor::execute;
use crate::{
    Error, Result, State, crypto,
    db::{flag, now, s},
};
use rusqlite::params;
use serde_json::json;
use std::{sync::Arc, time::Duration};
pub async fn start(state: Arc<State>, mut stop: tokio::sync::watch::Receiver<bool>) -> Result<()> {
    let owner = crypto::id("worker")?;
    let mut tasks = tokio::task::JoinSet::new();
    let mut running_dsps = std::collections::HashSet::new();
    let mut timer = tokio::time::interval(Duration::from_secs(1));
    let mut deadlines = std::collections::HashMap::<String, i64>::new();
    let mut schedule_revision = u64::MAX;
    let mut refreshed = 0;
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut checkpoint_cleanup = tokio::time::interval(Duration::from_secs(60));
    // A year's retention does not need checking every minute.
    let mut audit_pruned = 0;
    loop {
        tokio::select! {
            _=crate::cancelled(&mut stop)=>break,
            result=tasks.join_next(),if !tasks.is_empty()=>{
                match result {Some(Ok(dsp))=>{running_dsps.remove(&dsp);},Some(Err(_))=>return Err(Error::new("collector_task_failed",500)),None=>{}}
            },
            _=checkpoint_cleanup.tick()=>{
                let prune_audit = now()-audit_pruned >= 24*60*60*1000;
                if prune_audit { audit_pruned = now(); }
                let result = state.run(move |db| {
                    if prune_audit {
                        db.prune_audit()?;
                    }
                    // Expired access tokens have no remaining authentication purpose.
                    db.platform.transaction(|| {
                        db.platform.exec("DELETE FROM sessions WHERE expires_at<?", [now()])?;
                        db.platform.exec("DELETE FROM resets WHERE expires_at<?", [now()])?;
                        db.platform.exec("DELETE FROM invitations WHERE expires_at<?", [now()])?;
                        db.platform.exec("DELETE FROM throttle WHERE reset_at<?", [now()])?;
                        Ok(())
                    })?;
                    for dsp in db.platform.all("SELECT id FROM dsps WHERE status IN ('active','suspended')", [])? {
                        db.prune_checkpoints(s(&dsp,"id"))?;
                    }
                    Ok(())
                }).await;
                if let Err(error)=result { crate::observability::event("error", "checkpoint_cleanup_failed", json!({"error":error.code})); }
            },
            _=timer.tick()=>{
                state.expire_browsers().await;
                let revision = state.schedule_revision.load(std::sync::atomic::Ordering::Acquire);
                if revision != schedule_revision || now()-refreshed >= 60000 {
                    match state.read(|db| db.schedule_deadlines()).await {
                        Ok(values) => { deadlines = values.into_iter().collect(); schedule_revision = revision; refreshed = now(); },
                        Err(error) => crate::observability::event("error", "scheduler_refresh_failed", json!({"error":error.code})),
                    }
                }
                let due: Vec<_> = deadlines.iter().filter(|(_,at)| **at <= now()).map(|(id,_)| id.clone()).collect();
                for id in due {
                    let dsp = id.clone();
                    match state.run(move |db| db.schedule_due(&dsp)).await {
                        Ok(Some(next)) => { deadlines.insert(id,next); },
                        Ok(None) => { deadlines.remove(&id); },
                        Err(error) => { deadlines.insert(id,now()+5000); crate::observability::event("error", "scheduler_tick_failed", json!({"error":error.code})); },
                    }
                }
                // Poll indexed queue/lease state without a write lock. Recovery
                // still runs on the first tick after expiry, including quiet DSPs.
                let ready = match state.read(|db| db.jobs.one("SELECT EXISTS(SELECT 1 FROM jobs WHERE status='queued' AND available_at<=?1) queued,EXISTS(SELECT 1 FROM jobs WHERE status IN ('running','waiting_verification') AND lease_until<?1) expired",[now()])).await {
                    Ok(Some(value)) => value,
                    Ok(None) => continue,
                    Err(error) => { crate::observability::event("error", "job_poll_failed", json!({"error":error.code})); continue; },
                };
                if flag(&ready,"expired") && let Err(error) = state.run(|db| db.recover_jobs(false)).await { crate::observability::event("error", "job_recovery_failed", json!({"error":error.code})); }
                if !flag(&ready,"queued") && !flag(&ready,"expired") { continue; }
                while tasks.len()<state.config.browser_capacity {
                    let pool=state.clone();let claim_owner=owner.clone();
                    let running=running_dsps.clone();
                    let job=state.run(move|db| {
                        let memory_ready = (pool.config.fixture && pool.config.fixture_url.is_none()) || pool.browsers.admission().can_start;
                        let message = if memory_ready {"Waiting for a browser"} else {"Waiting for available memory"};
                        db.jobs.exec("UPDATE jobs SET message=?1 WHERE status='queued' AND available_at<=?2 AND message<>?1", params![message,now()])?;
                        db.claim(&claim_owner,|id,provider|!running.contains(id) && pool.browsers.get_for(id,provider).map(|s|!s.busy()&&!s.closed()).unwrap_or_else(||memory_ready && pool.browsers.active()<pool.config.browser_capacity))
                    }).await;
                    match job {Ok(Some(job))=>{let state=state.clone();let owner=owner.clone();let dsp=s(&job,"dsp_id").to_owned();running_dsps.insert(dsp.clone());tasks.spawn(async move{execute(state,job,owner).await;dsp});},Ok(None)=>break,Err(error)=>{crate::observability::event("error", "job_claim_failed", json!({"error":error.code}));break;}}
                }
            }
        }
    }
    state.browsers.close().await;
    while tasks.join_next().await.is_some() {}
    Ok(())
}
