//! What a session asks of a provider's browser. `paycom`, `cortex` and `fixture`
//! implement it; nothing outside this directory knows which one it is driving.
use super::browseros;
use crate::{Result, State, contracts::ActiveJobStatus, job_metrics::Recorder, meals::Scope};
use serde_json::Value;
use std::{future::Future, pin::Pin, sync::Arc};

pub type Pending<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

/// The claimed job a driver is collecting for.
pub struct Run<'a> {
    pub state: &'a Arc<State>,
    pub job: &'a str,
    pub owner: &'a str,
    pub timezone: &'a str,
    pub metrics: &'a Recorder,
    pub request: &'a Value,
}
impl Run<'_> {
    /// Shown on the job. Fails once the job is cancelled or no longer this worker's.
    pub async fn progress(&self, progress: i64, message: String) -> Result<()> {
        let job = self.job.to_owned();
        let owner = self.owner.to_owned();
        self.state
            .run(move |db| {
                db.guard_job(&job, &owner)?;
                db.progress(&job, &owner, progress, &message, ActiveJobStatus::Running)
            })
            .await
    }
}

/// A finished, unpublished collection, handed to its collector's `publish`.
pub struct Collected {
    pub data: Value,
    /// Set by a collector that resolves what it collected while collecting.
    pub scope: Option<Scope>,
}

pub trait Driver: Send {
    /// One connection command: `start`, `check`, `verify`, `complete_assistance`,
    /// `screenshot` or `assist`. Answers an event whose `type` names the outcome.
    fn request(&mut self, command: Value) -> Pending<'_, Value>;
    fn collect<'a>(&'a mut self, run: &'a Run<'a>) -> Pending<'a, Collected>;
    /// The browser to close with the session. A driver without one has nothing to close.
    fn browser(&self) -> Option<&browseros::Session>;
}
