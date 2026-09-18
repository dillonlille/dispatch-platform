pub mod accounts;
pub mod browsers;
pub mod collection_checkpoint;
pub mod collectors;
pub mod config;
pub mod contracts;
pub mod crypto;
pub mod db;
pub mod error;
pub mod http;
pub mod job_metrics;
pub mod jobs;
pub mod live_collection;
pub mod mail;
pub mod meal_comparison;
pub mod meal_sync;
pub mod meals;
pub mod observability;
pub mod operations;
pub mod proxy;
pub mod tenants;
pub mod validate;
pub mod workforce;

pub use error::{Error, Result, ensure};
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::Semaphore;

pub struct State {
    pub config: config::Config,
    pub key: Vec<u8>,
    pub assets: std::collections::HashMap<String, http::Asset>,
    pub db_slots: Arc<Semaphore>,
    pub db_queue: Arc<Semaphore>,
    // Serializes short state transitions across the platform, jobs and tenant databases.
    pub transition: RwLock<()>,
    pub pool: Mutex<Vec<db::Store>>,
    pub schedule_revision: std::sync::atomic::AtomicU64,
    pub password_slots: Arc<Semaphore>,
    pub mail_transport: Mutex<mail::TransportHealth>,
    pub browsers: browsers::Manager,
    pub updates: live_collection::Updates,
}
impl State {
    pub fn new(config: config::Config) -> Result<Arc<Self>> {
        let store = db::Store::initialize(config.clone())?;
        for dsp in store.platform.all(
            "SELECT id FROM dsps WHERE status IN ('active','suspended')",
            [],
        )? {
            for provider in collectors::Provider::ALL {
                store.collector(db::s(&dsp, "id"), *provider)?.exec("UPDATE connections SET status='error',error='verification_expired' WHERE status IN ('signing_in','needs_verification')",[])?;
            }
        }
        Ok(Arc::new(Self {
            key: store.key.clone(),
            assets: http::assets(&config.dashboard)?,
            config,
            db_slots: Arc::new(Semaphore::new(4)),
            db_queue: Arc::new(Semaphore::new(64)),
            transition: RwLock::new(()),
            pool: Mutex::new(vec![store]),
            schedule_revision: std::sync::atomic::AtomicU64::new(0),
            password_slots: Arc::new(Semaphore::new(2)),
            mail_transport: Mutex::new(mail::TransportHealth::default()),
            browsers: browsers::Manager::default(),
            updates: live_collection::Updates::new()?,
        }))
    }
    pub async fn run<T: Send + 'static>(
        self: &Arc<Self>,
        f: impl FnOnce(&db::Store) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.database(true, f).await
    }
    pub async fn read<T: Send + 'static>(
        self: &Arc<Self>,
        f: impl FnOnce(&db::Store) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.database(false, f).await
    }
    async fn database<T: Send + 'static>(
        self: &Arc<Self>,
        write: bool,
        f: impl FnOnce(&db::Store) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        // Bound both queued requests and blocking threads. Short bursts wait without
        // allocating another database pool or failing otherwise healthy requests.
        let queued = self
            .db_queue
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::new("platform_busy", 503))?;
        let permit = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            self.db_slots.clone().acquire_owned(),
        )
        .await
        .map_err(|_| Error::new("platform_busy", 503))?
        .map_err(|_| Error::new("platform_unavailable", 503))?;
        let state = self.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let _queued = queued;
            let pooled = state
                .pool
                .lock()
                .map_err(|_| Error::new("platform_unavailable", 503))?
                .pop();
            let db = match pooled {
                Some(db) => db,
                None => db::Store::open(state.config.clone(), state.key.clone())?,
            };
            let result = if write {
                let _guard = state
                    .transition
                    .write()
                    .map_err(|_| Error::new("platform_unavailable", 503))?;
                f(&db)
            } else {
                let _guard = state
                    .transition
                    .read()
                    .map_err(|_| Error::new("platform_unavailable", 503))?;
                f(&db)
            };
            state
                .pool
                .lock()
                .map_err(|_| Error::new("platform_unavailable", 503))?
                .push(db);
            result
        })
        .await
        .map_err(|_| Error::new("operation_failed", 500))?
    }
}

pub async fn cancelled(receiver: &mut tokio::sync::watch::Receiver<bool>) {
    let _ = receiver.wait_for(|v| *v).await;
}

/// An essential background task ending unexpectedly must stop serving readiness.
/// Systemd can then restart the whole core and recover its durable jobs.
pub async fn supervise(
    task: impl std::future::Future<Output = Result<()>> + Send + 'static,
    stop: tokio::sync::watch::Sender<bool>,
) -> Result<()> {
    let result = tokio::spawn(task)
        .await
        .unwrap_or_else(|_| Err(Error::new("background_task_failed", 500)));
    if !*stop.borrow() {
        stop.send_replace(true);
        return Err(result
            .err()
            .unwrap_or_else(|| Error::new("background_task_stopped", 500)));
    }
    result
}
