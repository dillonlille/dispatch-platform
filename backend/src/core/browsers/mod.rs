pub mod browseros;
pub mod egress;
mod paycom;
pub mod sandbox;
use super::{
    Error, Result, State,
    accounts::Context,
    crypto,
    db::{self, Store, flag, iso, n, s},
    ensure, validate as v, workforce,
};
use rusqlite::params;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, watch};
#[derive(Default)]
pub struct Manager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    operations: Mutex<HashMap<String, std::sync::Weak<AsyncMutex<()>>>>,
}
pub struct Session {
    pub id: String,
    pub dsp: String,
    pub revision: i64,
    pub timezone: String,
    run: PathBuf,
    status: AtomicU8, // 0 starting, 1 ready, 2 challenge, 3 closed
    worker: AsyncMutex<Option<Worker>>,
    commands: tokio::sync::Semaphore,
    cancel: watch::Sender<bool>,
    fixture: bool,
    started: std::time::Instant,
    last_used: Mutex<std::time::Instant>,
    collecting: std::sync::atomic::AtomicBool,
}
type Worker = paycom::Driver;
impl Manager {
    pub fn operation(&self, id: &str) -> Result<tokio::sync::OwnedMutexGuard<()>> {
        let lock = {
            let mut operations = self
                .operations
                .lock()
                .map_err(|_| Error::new("browser_unavailable", 503))?;
            operations.retain(|_, lock| lock.strong_count() > 0);
            if let Some(lock) = operations.get(id).and_then(std::sync::Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(AsyncMutex::new(()));
                operations.insert(id.into(), Arc::downgrade(&lock));
                lock
            }
        };
        lock.try_lock_owned()
            .map_err(|_| Error::new("connection_busy", 409))
    }
    pub async fn revoke_current(&self, session: &Arc<Session>) {
        let removed = {
            let mut sessions = self.sessions.lock().expect("browser registry");
            if sessions
                .get(&session.dsp)
                .is_some_and(|current| Arc::ptr_eq(current, session))
            {
                sessions.remove(&session.dsp)
            } else {
                None
            }
        };
        if let Some(session) = removed {
            session.close().await;
        }
    }
    pub async fn revoke_revision(&self, id: &str, revision: i64) {
        if let Some(session) = self.get(id)
            && session.revision == revision
        {
            self.revoke_current(&session).await;
        }
    }

    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().ok()?.get(id).cloned()
    }
    pub fn active(&self) -> usize {
        self.sessions.lock().map(|s| s.len()).unwrap_or(0)
    }
    pub async fn revoke(&self, id: &str) {
        let session = self.sessions.lock().ok().and_then(|mut s| s.remove(id));
        if let Some(session) = session {
            session.close().await;
        }
    }
    pub async fn close(&self) {
        let sessions = self
            .sessions
            .lock()
            .map(|mut s| s.drain().map(|(_, s)| s).collect::<Vec<_>>())
            .unwrap_or_default();
        for s in sessions {
            s.close().await;
        }
    }
}
impl Session {
    pub fn ready(&self) -> bool {
        self.status.load(Ordering::SeqCst) == 1
    }
    pub fn challenge(&self) -> bool {
        self.status.load(Ordering::SeqCst) == 2
    }
    pub fn closed(&self) -> bool {
        self.status.load(Ordering::SeqCst) == 3
    }
    pub fn interactive(&self) -> bool {
        self.challenge() && !self.fixture
    }
    pub fn busy(&self) -> bool {
        self.status.load(Ordering::SeqCst) == 0
            || self.worker.try_lock().is_err()
            || self.collecting.load(Ordering::SeqCst)
    }
    async fn close(&self) {
        self.status.store(3, Ordering::SeqCst);
        self.cancel.send_replace(true);
        if let Some(worker) = self.worker.lock().await.take() {
            worker.browser.close().await;
        }
        let _ = std::fs::remove_dir_all(&self.run);
    }
    pub async fn request(&self, command: Value, types: &[&str], seconds: u64) -> Result<Value> {
        self.request_guarded(command, types, seconds, None).await
    }
    pub async fn request_guarded(
        &self,
        command: Value,
        types: &[&str],
        seconds: u64,
        guard: Option<(&Arc<State>, &Context)>,
    ) -> Result<Value> {
        ensure(!self.closed(), "verification_expired", 409)?;
        let _slot = self
            .commands
            .try_acquire()
            .map_err(|_| Error::new("connection_busy", 409))?;
        let mut cancellation = self.cancel.subscribe();
        let mut worker = tokio::select! {
            _=super::cancelled(&mut cancellation)=>return Err(Error::new("verification_expired",409)),
            lock=tokio::time::timeout(Duration::from_secs(seconds),self.worker.lock())=>lock.map_err(|_|Error::new("provider_timeout",504))?,
        };
        ensure(!self.closed(), "verification_expired", 409)?;
        if let Some((state, context)) = guard {
            let context = context.clone();
            state
                .read(move |db| db.revalidate(&context, "connections"))
                .await?;
        }
        if ["screenshot", "assist", "complete_assistance"].contains(&s(&command, "action")) {
            ensure(self.interactive(), "verification_expired", 409)?;
        }
        *self.last_used.lock().expect("browser idle clock") = std::time::Instant::now();
        if self.fixture {
            match s(&command, "action") {
                "start" | "check" => {
                    let password = s(&command["credentials"], "password");
                    ensure(password != "invalid-password", "invalid_credentials", 409)?;
                    self.status.store(
                        if password == "require-verification" {
                            2
                        } else {
                            1
                        },
                        Ordering::SeqCst,
                    );
                }
                "verify" => {
                    ensure(self.challenge(), "verification_not_requested", 409)?;
                    ensure(
                        s(&command, "code") == "123456",
                        "invalid_verification_code",
                        409,
                    )?;
                    self.status.store(1, Ordering::SeqCst);
                }
                _ => return Err(Error::new("verification_expired", 409)),
            }
            return Ok(json!({"type":if self.ready(){"ready"}else{"challenge"}}));
        }
        let worker = worker
            .as_mut()
            .ok_or_else(|| Error::new("browser_unavailable", 409))?;
        let mut cancellation = self.cancel.subscribe();
        let response = worker.request(command);
        let event = tokio::select! {
            _=cancellation.wait_for(|closed|*closed)=>Err(Error::new("verification_expired",409)),
            result=tokio::time::timeout(Duration::from_secs(seconds),response)=>result.map_err(|_|Error::new("provider_timeout",504))?,
        }?;
        ensure(
            types.contains(&s(&event, "type")),
            "browser_protocol_failed",
            502,
        )?;
        *self.last_used.lock().expect("browser idle clock") = std::time::Instant::now();
        if s(&event, "type") == "ready" {
            self.status.store(1, Ordering::SeqCst);
        }
        if s(&event, "type") == "challenge" {
            self.status.store(2, Ordering::SeqCst);
        }
        Ok(event)
    }
    pub async fn collect(
        self: &Arc<Self>,
        state: &Arc<State>,
        job: &str,
        owner: &str,
    ) -> Result<Value> {
        ensure(self.ready(), "verification_required", 409)?;
        ensure(
            !self.collecting.swap(true, Ordering::SeqCst),
            "connection_busy",
            409,
        )?;
        if self.fixture {
            tokio::time::sleep(Duration::from_millis(100)).await;
            return workforce::fixture(&self.timezone);
        }
        let mut worker = self.worker.lock().await;
        let worker = worker
            .as_mut()
            .ok_or_else(|| Error::new("browser_unavailable", 409))?;
        let mut cancellation = self.cancel.subscribe();
        let response = worker.collect(&self.timezone, |progress, message| {
            let job = job.to_owned();
            let owner = owner.to_owned();
            async move {
                state
                    .run(move |db| {
                        db.guard_job(&job, &owner)?;
                        db.progress(&job, &owner, progress, &message, "running")
                    })
                    .await
            }
        });
        tokio::select! {
            _=cancellation.wait_for(|closed|*closed)=>Err(Error::new("job_cancelled",409)),
            result=tokio::time::timeout(Duration::from_secs(1800),response)=>result.map_err(|_|Error::new("provider_timeout",504))?,
        }
    }
}
pub fn validate_credentials(value: &Value) -> Result<()> {
    v::fields(
        value,
        &["clientCode", "username", "password", "securityAnswers"],
    )?;
    v::name(value, "clientCode", 80)?;
    v::name(value, "username", 200)?;
    v::text(value, "password", 1, 256)?;
    let answers = value["securityAnswers"]
        .as_array()
        .ok_or_else(|| Error::new("invalid_input", 400))?;
    ensure(
        answers.len() == 5
            && answers.iter().all(|a| {
                a.as_str().is_some_and(|s| {
                    !s.is_empty() && s.chars().count() <= 64 && !s.contains(['\r', '\n', '\0'])
                })
            })
            && answers
                .iter()
                .map(Value::to_string)
                .collect::<HashSet<_>>()
                .len()
                == 5,
        "invalid_input",
        400,
    )
}
impl Store {
    pub fn connection(&self, id: &str) -> Result<Value> {
        let mut row=self.dsp(id)?.one("SELECT provider,enabled,status,error,updated_at updatedAt,verified_at lastVerifiedAt,account_label accountLabel FROM connections WHERE provider='paycom'",[])?.ok_or_else(||Error::new("connection_required",409))?;
        db::boolean(&mut row, &["enabled"]);
        Ok(row)
    }
    pub fn connection_state(
        &self,
        id: &str,
        revision: i64,
        status: &str,
        error: Option<&str>,
    ) -> Result<()> {
        self.dsp(id)?.exec("UPDATE connections SET status=?,error=?,updated_at=?,verified_at=CASE WHEN ?='ready' THEN ? ELSE verified_at END WHERE provider='paycom' AND revision=? AND enabled=1",params![status,error,iso(),status,iso(),revision])?;
        Ok(())
    }
    pub fn save_credentials(&self, c: &Context, value: &Value) -> Result<()> {
        self.revalidate(c, "connections")?;
        validate_credentials(value)?;
        let id = s(&c.dsp, "id");
        let area = self.area(id, "secrets")?;
        let key = db::key_file(&area.join("vault.key"))?;
        db::write_private(
            &area.join("paycom.enc"),
            crypto::encrypt(&key, &format!("{id}:paycom:2"), value)?.as_bytes(),
        )?;
        self.dsp(id)?.exec("UPDATE connections SET enabled=1,status='not_connected',error=NULL,account_label=?,verified_at=NULL,revision=revision+1,updated_at=? WHERE provider='paycom'",[s(value,"clientCode"),&iso()])?;
        let profile = self.area(id, "state")?.join("browsers");
        if profile.exists() {
            db::private_dir(&profile)?;
            std::fs::remove_dir_all(profile)?;
        }
        self.audit(
            Some(s(&c.auth.user, "id")),
            Some(id),
            "connection.credentials_saved",
            "",
        )
    }
    pub fn credentials(&self, id: &str) -> Result<Value> {
        let area = self.area(id, "secrets")?;
        let path = area.join("paycom.enc");
        db::private_file(&path, false)?;
        let key = db::key_file(&area.join("vault.key"))?;
        crypto::decrypt(
            &key,
            &format!("{id}:paycom:2"),
            &std::fs::read_to_string(path)?,
        )
    }
    pub fn disable(&self, c: &Context, remove: bool) -> Result<()> {
        self.revalidate(c, "connections")?;
        let id = s(&c.dsp, "id");
        let db = self.dsp(id)?;
        db.transaction(||{db.exec("UPDATE connections SET enabled=0,status='not_connected',error=NULL,revision=revision+1,updated_at=? WHERE provider='paycom'",[iso()])?;db.exec("UPDATE schedules SET enabled=0,next_run=NULL",[])?;Ok(())})?;
        if remove {
            let file = self.area(id, "secrets")?.join("paycom.enc");
            db::private_file(&file, false)?;
            if file.exists() {
                std::fs::remove_file(file)?;
            }
        }
        self.audit(
            Some(s(&c.auth.user, "id")),
            Some(id),
            "connection.disabled",
            "",
        )
    }
}
impl State {
    pub async fn expire_browsers(self: &Arc<Self>) {
        let ids = self
            .browsers
            .sessions
            .lock()
            .map(|s| {
                s.values()
                    .filter(|s| {
                        s.closed()
                            || (s.ready()
                                && !s.busy()
                                && s.last_used
                                    .lock()
                                    .is_ok_and(|time| time.elapsed() > Duration::from_secs(60)))
                            || s.started.elapsed()
                                > Duration::from_secs(if s.collecting.load(Ordering::SeqCst) {
                                    1800
                                } else {
                                    600
                                })
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for session in ids {
            let expired = session.challenge() || !session.ready();
            self.browsers.revoke_current(&session).await;
            if expired {
                let id = session.dsp.clone();
                let revision = session.revision;
                let _ = self
                    .run(move |db| {
                        db.connection_state(&id, revision, "error", Some("verification_expired"))
                    })
                    .await;
            }
        }
    }
    pub async fn connection(self: &Arc<Self>, id: &str) -> Result<Value> {
        let dsp = id.to_owned();
        let mut value = self.run(move |db| db.connection(&dsp)).await?;
        if let Some(session) = self.browsers.get(id)
            && session.interactive()
        {
            value["verificationSessionId"] = json!(session.id);
        }
        Ok(value)
    }
    pub async fn ensure_browser(self: &Arc<Self>, id: &str, retry: bool) -> Result<Arc<Session>> {
        let dsp = id.to_owned();
        let (dsp, credentials, revision, run, profile) = self
            .run(move |db| {
                let value = db.get_dsp(&dsp)?;
                ensure(
                    s(&value, "status") == "active"
                        && s(&value, "environment") == db.config.environment,
                    "dsp_unavailable",
                    409,
                )?;
                let connection = db
                    .dsp(&dsp)?
                    .one(
                        "SELECT enabled,revision FROM connections WHERE provider='paycom'",
                        [],
                    )?
                    .ok_or_else(|| Error::new("connection_required", 409))?;
                ensure(flag(&connection, "enabled"), "connection_required", 409)?;
                let runs = db::private_dir(&db.config.environment_root().join("browser-runs"))?;
                let run = runs.join(crypto::id("run")?);
                let profile = db::private_dir(&db.area(&dsp, "state")?.join("browsers"))?
                    .join("paycom-browseros");
                Ok((
                    value,
                    db.credentials(&dsp)?,
                    n(&connection, "revision"),
                    run,
                    profile,
                ))
            })
            .await?;
        if let Some(session) = self.browsers.get(id) {
            ensure(!session.closed() && !session.busy(), "connection_busy", 409)?;
            ensure(session.revision == revision, "connection_changed", 409)?;
            if retry {
                let result = session
                    .request(
                        json!({"action":"check","credentials":credentials}),
                        &["ready", "challenge"],
                        180,
                    )
                    .await;
                self.browser_result(&session, &result).await?;
                if result.is_err() {
                    self.browsers.revoke_current(&session).await;
                }
                result?;
            }
            return Ok(session);
        }
        let (cancel, _) = watch::channel(false);
        let session = Arc::new(Session {
            id: run.file_name().unwrap().to_string_lossy().into_owned(),
            dsp: id.into(),
            revision,
            timezone: s(&dsp, "timezone").into(),
            run: run.clone(),
            status: AtomicU8::new(0),
            worker: AsyncMutex::new(None),
            commands: tokio::sync::Semaphore::new(32),
            cancel,
            fixture: self.config.fixture && self.config.fixture_url.is_none(),
            started: std::time::Instant::now(),
            last_used: Mutex::new(std::time::Instant::now()),
            collecting: std::sync::atomic::AtomicBool::new(false),
        });
        {
            let mut sessions = self
                .browsers
                .sessions
                .lock()
                .map_err(|_| Error::new("browser_unavailable", 503))?;
            ensure(!sessions.contains_key(id), "connection_busy", 409)?;
            ensure(
                sessions.len() < self.config.browser_capacity,
                "browser_capacity_busy",
                429,
            )?;
            sessions.insert(id.into(), session.clone());
        }
        let start=async {
            let mut worker = session.worker.lock().await;
            ensure(!session.closed(), "verification_expired", 409)?;
            let dsp=id.to_owned();self.run(move|db| {
                let tenant = db.get_dsp(&dsp)?;
                ensure(s(&tenant,"status")=="active", "dsp_unavailable",409)?;
                let connection = db.dsp(&dsp)?.one("SELECT enabled,revision FROM connections WHERE provider='paycom'",[])?.ok_or_else(||Error::new("connection_required",409))?;
                ensure(flag(&connection,"enabled") && n(&connection,"revision")==revision,"connection_changed",409)?;
                db.connection_state(&dsp,revision,"signing_in",None)
            }).await?;
            ensure(!session.closed(), "verification_expired", 409)?;
            db::private_dir(&run)?;db::private_dir(&profile)?;
            if !session.fixture {
                paycom::preflight(&profile,retry)?;
                let policy=if let Some(value)=&self.config.fixture_url {
                    browseros::NetworkPolicy::Fixture(std::num::NonZeroU16::new(url::Url::parse(value).expect("validated fixture URL").port().unwrap()).unwrap())
                } else { browseros::NetworkPolicy::Paycom };
                let runtime=browseros::Runtime::new(&self.config.browseros,&self.config.sandbox,
                    &std::env::current_exe()?, &run, self.config.browser_capacity)?;
                let browser=runtime.start(&profile,browseros::Mode::Windowed,policy).await?;
                *worker=Some(paycom::Driver::new(browser,&profile,self.config.fixture_url.as_deref()).await?);

            }
            drop(worker);
            session.request(json!({"action":"start","credentials":credentials,"timezone":session.timezone,"ownerRetry":retry,"fixtureUrl":self.config.fixture_url}),&["ready","challenge"],180).await
        }.await;
        self.browser_result(&session, &start).await?;
        if let Err(error) = start {
            self.browsers.revoke_current(&session).await;
            return Err(error);
        }
        Ok(session)
    }
    pub async fn browser_result(
        self: &Arc<Self>,
        session: &Arc<Session>,
        result: &Result<Value>,
    ) -> Result<()> {
        let dsp = session.dsp.clone();
        let revision = session.revision;
        let recoverable = result.as_ref().is_err_and(|e| {
            [
                "invalid_verification_code",
                "verification_incomplete",
                "connection_busy",
            ]
            .contains(&e.code.as_str())
        });
        let status = if result.is_ok() || recoverable {
            if session.ready() {
                "ready"
            } else {
                "needs_verification"
            }
        } else {
            "error"
        };
        let error = if recoverable {
            None
        } else {
            result.as_ref().err().map(|e| e.code.clone())
        };
        self.run(move |db| db.connection_state(&dsp, revision, status, error.as_deref()))
            .await
    }
}
