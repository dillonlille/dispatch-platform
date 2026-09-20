use super::executor::execute;
use crate::{
    Error, Result, State,
    contracts::JobRow,
    crypto,
    db::{FromRow, Row, now},
    job_statuses,
};
use rusqlite::params;
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

// Poll indexed queue/lease state without a write lock.
const READY: &str = concat!(
    "SELECT EXISTS(SELECT 1 FROM jobs WHERE status='queued' AND available_at<=?1) queued,\
     EXISTS(SELECT 1 FROM jobs WHERE status IN ",
    job_statuses!(leased),
    " AND lease_until<?1) expired"
);
const WAITING_MESSAGE: &str =
    "UPDATE jobs SET message=?1 WHERE status='queued' AND available_at<=?2 AND message<>?1";

struct Ready {
    queued: bool,
    expired: bool,
}
impl FromRow for Ready {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            queued: row.get("queued")?,
            expired: row.get("expired")?,
        })
    }
}
fn failed(event: &str, error: &Error) {
    crate::observability::event("error", event, json!({"error":error.code}));
}

struct Scheduler {
    state: Arc<State>,
    owner: String,
    tasks: tokio::task::JoinSet<String>,
    running_dsps: HashSet<String>,
    deadlines: HashMap<String, i64>,
    schedule_revision: u64,
    refreshed: i64,
    // A year's retention does not need checking every minute.
    audit_pruned: i64,
}
impl Scheduler {
    async fn cleanup(&mut self) {
        let prune_audit = now() - self.audit_pruned >= 24 * 60 * 60 * 1000;
        if prune_audit {
            self.audit_pruned = now();
        }
        let result = self
            .state
            .run(move |db| {
                if prune_audit {
                    db.prune_audit()?;
                }
                // Expired access tokens have no remaining authentication purpose.
                db.platform.transaction(|| {
                    for sql in [
                        "DELETE FROM sessions WHERE expires_at<?",
                        "DELETE FROM resets WHERE expires_at<?",
                        // An accepted invitation stays 90 days, so Diagnostics can show
                        // that it was accepted. It can no longer be used.
                        "DELETE FROM invitations WHERE expires_at<?1 AND \
                         (used_at IS NULL OR used_at<?1-7776000000)",
                        "DELETE FROM throttle WHERE reset_at<?",
                    ] {
                        db.platform.exec(sql, [now()])?;
                    }
                    Ok(())
                })?;
                let dsps: Vec<(String,)> = db.platform.query_as(
                    "SELECT id FROM dsps WHERE status IN ('active','suspended')",
                    [],
                )?;
                for (dsp,) in dsps {
                    db.prune_checkpoints(&dsp)?;
                }
                Ok(())
            })
            .await;
        if let Err(error) = result {
            failed("checkpoint_cleanup_failed", &error);
        }
    }
    async fn run_due_schedules(&mut self) {
        let state = &self.state;
        let revision = state
            .schedule_revision
            .load(std::sync::atomic::Ordering::Acquire);
        if revision != self.schedule_revision || now() - self.refreshed >= 60000 {
            match state.read(|db| db.schedule_deadlines()).await {
                Ok(values) => {
                    self.deadlines = values.into_iter().collect();
                    self.schedule_revision = revision;
                    self.refreshed = now();
                }
                Err(error) => failed("scheduler_refresh_failed", &error),
            }
        }
        let due: Vec<_> = self
            .deadlines
            .iter()
            .filter(|(_, at)| **at <= now())
            .map(|(id, _)| id.clone())
            .collect();
        for id in due {
            let dsp = id.clone();
            match state.run(move |db| db.schedule_due(&dsp)).await {
                Ok(Some(next)) => {
                    self.deadlines.insert(id, next);
                }
                Ok(None) => {
                    self.deadlines.remove(&id);
                }
                Err(error) => {
                    self.deadlines.insert(id, now() + 5000);
                    failed("scheduler_tick_failed", &error);
                }
            }
        }
    }
    async fn claim(&self) -> Result<Option<JobRow>> {
        let pool = self.state.clone();
        let owner = self.owner.clone();
        let running = self.running_dsps.clone();
        self.state
            .run(move |db| {
                let memory_ready = (pool.config.fixture && pool.config.fixture_url.is_none())
                    || pool.browsers.admission().can_start;
                let message = if memory_ready {
                    "Waiting for a browser"
                } else {
                    "Waiting for available memory"
                };
                db.jobs.exec(WAITING_MESSAGE, params![message, now()])?;
                db.claim_job(&owner, |id, provider| {
                    !running.contains(id)
                        && pool
                            .browsers
                            .get_for(id, provider)
                            .map(|s| !s.busy() && !s.closed())
                            .unwrap_or_else(|| {
                                memory_ready
                                    && pool.browsers.active() < pool.config.browser_capacity
                            })
                })
            })
            .await
    }
    async fn tick(&mut self) {
        self.state.expire_browsers().await;
        self.run_due_schedules().await;
        // Recovery still runs on the first tick after expiry, including quiet DSPs.
        let ready = match self
            .state
            .read(|db| db.jobs.one_as::<Ready>(READY, [now()]))
            .await
        {
            Ok(Some(value)) => value,
            Ok(None) => return,
            Err(error) => return failed("job_poll_failed", &error),
        };
        if ready.expired
            && let Err(error) = self.state.run(|db| db.recover_jobs(false)).await
        {
            failed("job_recovery_failed", &error);
        }
        if !ready.queued && !ready.expired {
            return;
        }
        while self.tasks.len() < self.state.config.browser_capacity {
            match self.claim().await {
                Ok(Some(job)) => {
                    let state = self.state.clone();
                    let owner = self.owner.clone();
                    let dsp = job.dsp_id.clone();
                    self.running_dsps.insert(dsp.clone());
                    self.tasks.spawn(async move {
                        execute(state, job, owner).await;
                        dsp
                    });
                }
                Ok(None) => break,
                Err(error) => {
                    failed("job_claim_failed", &error);
                    break;
                }
            }
        }
    }
}
pub async fn start(state: Arc<State>, mut stop: tokio::sync::watch::Receiver<bool>) -> Result<()> {
    let mut scheduler = Scheduler {
        state,
        owner: crypto::id("worker")?,
        tasks: tokio::task::JoinSet::new(),
        running_dsps: HashSet::new(),
        deadlines: HashMap::new(),
        schedule_revision: u64::MAX,
        refreshed: 0,
        audit_pruned: 0,
    };
    let mut timer = tokio::time::interval(Duration::from_secs(1));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut checkpoint_cleanup = tokio::time::interval(Duration::from_secs(60));
    loop {
        tokio::select! {
            _ = crate::cancelled(&mut stop) => break,
            result = scheduler.tasks.join_next(), if !scheduler.tasks.is_empty() => {
                match result {
                    Some(Ok(dsp)) => {
                        scheduler.running_dsps.remove(&dsp);
                    }
                    Some(Err(_)) => return Err(Error::new("collector_task_failed", 500)),
                    None => {}
                }
            },
            _ = checkpoint_cleanup.tick() => scheduler.cleanup().await,
            _ = timer.tick() => scheduler.tick().await,
        }
    }
    scheduler.state.browsers.close().await;
    while scheduler.tasks.join_next().await.is_some() {}
    Ok(())
}
