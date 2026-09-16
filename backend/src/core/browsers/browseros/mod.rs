//! Internal Rust browser runtime. Provider adapters own these handles; no raw CDP
//! endpoint, client-supplied path, or script is exposed through the platform API.
mod cdp;
mod loading;
mod native;
mod sandbox;
mod worker;

use super::egress::Egress;
use crate::core::{Error, Result, crypto, db, ensure};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{Semaphore, mpsc, oneshot, watch},
    time::{Instant, timeout, timeout_at},
};

const COMMAND_BYTES: u64 = 64 * 1024;
const RESPONSE_BYTES: u64 = cdp::MAX_FRAME + 1024;
const QUEUE_SIZE: usize = 8;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const START_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy)]
pub enum Mode {
    Headless,
    Windowed,
}
impl Mode {
    fn argument(self) -> &'static str {
        match self {
            Self::Headless => "headless",
            Self::Windowed => "windowed",
        }
    }
}

/// Chosen by trusted host code, never deserialized from a DSP request.
#[derive(Clone, Copy)]
pub enum NetworkPolicy {
    Paycom,
    Cortex,
    /// Synthetic local server, reachable only as fixture.dispatch.invalid.
    Fixture(std::num::NonZeroU16),
}

pub struct Runtime {
    browser: PathBuf,
    sandbox: PathBuf,
    executable: PathBuf,
    runs: PathBuf,
    slots: Arc<Semaphore>,
}
impl Runtime {
    pub fn new(
        browser: &Path,
        sandbox: &Path,
        executable: &Path,
        runs: &Path,
        capacity: usize,
    ) -> Result<Self> {
        ensure(
            (1..=16).contains(&capacity),
            "invalid_browser_capacity",
            400,
        )?;
        let browser = sandbox::trusted(browser, true)?;
        ensure(
            browser.file_name().is_some_and(|s| s == "browseros"),
            "browseros_required",
            503,
        )?;
        let executable = sandbox::trusted(executable, false)?;
        Ok(Self {
            browser,
            sandbox: sandbox::trusted(sandbox, true)?,
            executable,
            runs: db::private_dir(runs)?,
            slots: Arc::new(Semaphore::new(capacity)),
        })
    }

    /// Profile paths are derived by the host from its DSP registry. Only this
    /// profile and the egress socket are mounted; the lock stays outside.
    pub async fn start(
        &self,
        profile: &Path,
        mode: Mode,
        policy: NetworkPolicy,
    ) -> Result<Session> {
        if matches!(mode, Mode::Windowed) {
            sandbox::trusted(Path::new("/usr/bin/Xvfb"), true)?;
        }
        let slot = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::new("browser_capacity_busy", 429))?;
        let lease = profile_lease(profile)?;
        // Credentials belong to the DSP vault; password-manager chrome must not
        // cover native PIN entry or persist another copy in the browser profile.
        let defaults = db::private_dir(&profile.join("Default"))?;
        let preferences = defaults.join("Preferences");
        db::private_file(&preferences, false)?;
        let mut settings: Value = if preferences.exists() {
            ensure(
                fs::metadata(&preferences)?.len() <= 4 * 1024 * 1024,
                "browser_profile_invalid",
                409,
            )?;
            serde_json::from_slice(&fs::read(&preferences)?)?
        } else {
            json!({})
        };
        ensure(
            settings.is_object()
                && (settings["profile"].is_null() || settings["profile"].is_object()),
            "browser_profile_invalid",
            409,
        )?;
        settings["credentials_enable_service"] = json!(false);
        settings["profile"]["password_manager_enabled"] = json!(false);
        db::write_private(&preferences, &serde_json::to_vec(&settings)?)?;
        let run = RunDirectory::create(&self.runs)?;
        let egress = Egress::start_with_policy(&run.0, policy)?;
        let child = sandbox::launch(self, &run.0, profile, mode)?;
        let process_id = child.id().expect("new browser supervisor");
        let (sender, requests) = mpsc::channel(QUEUE_SIZE);
        let (stop, cancellation) = watch::channel(false);
        let (finished, closed) = watch::channel(None);
        let (ready, started) = oneshot::channel();
        tokio::spawn(async move {
            let mut child = child;
            serve_child(&mut child, requests, cancellation, ready).await;
            let exit = stop_child(&mut child).await;
            // Release leases only after reaping the namespace supervisor.
            drop(child);
            drop(egress);
            drop(run);
            drop(lease);
            drop(slot);
            finished.send_replace(Some(exit));
        });
        let session = Session(Arc::new(Handle {
            sender,
            stop,
            closed,
            process_id,
        }));
        match started.await {
            Ok(Ok(())) => Ok(session),
            Ok(Err(error)) => {
                session.close().await;
                Err(error)
            }
            Err(_) => {
                session.close().await;
                Err(Error::new("browser_start_failed", 503))
            }
        }
    }
}

fn profile_lease(profile: &Path) -> Result<File> {
    db::private_dir(profile)?;
    let parent = profile
        .parent()
        .ok_or_else(|| Error::new("unsafe_storage_path", 500))?;
    db::private_dir(parent)?;
    let name = profile
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| Error::new("unsafe_storage_path", 500))?;
    let path = parent.join(format!(".{name}.browseros.lock"));
    db::private_file(&path, true)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)?;
    let stat = file.metadata()?;
    ensure(
        stat.is_file()
            && stat.nlink() == 1
            && stat.uid() == unsafe { libc::geteuid() }
            && stat.mode() & 0o077 == 0,
        "unsafe_storage_file",
        500,
    )?;
    file.try_lock_exclusive()
        .map_err(|_| Error::new("browser_profile_busy", 409))?;
    Ok(file)
}

struct RunDirectory(PathBuf);
impl RunDirectory {
    fn create(root: &Path) -> Result<Self> {
        let path = root.join(crypto::id("browseros")?);
        fs::DirBuilder::new().mode(0o700).create(&path)?;
        Ok(Self(path))
    }
}
impl Drop for RunDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Exit {
    pub graceful: bool,
    pub supervisor_reaped: bool,
}
struct Handle {
    sender: mpsc::Sender<Request>,
    stop: watch::Sender<bool>,
    closed: watch::Receiver<Option<Exit>>,
    process_id: u32,
}
impl Drop for Handle {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}
#[derive(Clone)]
pub struct Session(Arc<Handle>);
struct Request {
    bytes: Vec<u8>,
    deadline: Instant,
    reply: oneshot::Sender<Result<Value>>,
}

impl Session {
    /// Host supervisor PID for operational diagnostics, never a control endpoint.
    pub fn process_id(&self) -> u32 {
        self.0.process_id
    }
    /// Serialized commands for trusted provider scripts. Queueing is bounded;
    /// abandoning an in-flight command retires this entire session.
    pub async fn command(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value> {
        ensure(
            !*self.0.stop.borrow() && self.0.closed.borrow().is_none(),
            "browser_closed",
            409,
        )?;
        self.send(WireCommand::Cdp {
            method: method.into(),
            params,
            session: session.map(str::to_owned),
        })
        .await
    }
    async fn send(&self, command: WireCommand) -> Result<Value> {
        let bytes = frame(&command, COMMAND_BYTES)?;
        let (reply, response) = oneshot::channel();
        self.0
            .sender
            .try_send(Request {
                bytes,
                deadline: Instant::now() + COMMAND_TIMEOUT,
                reply,
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => Error::new("browser_queue_full", 429),
                mpsc::error::TrySendError::Closed(_) => Error::new("browser_closed", 409),
            })?;
        response
            .await
            .map_err(|_| Error::new("browser_closed", 409))?
    }
    pub async fn navigation(&self, session: &str, previous: &str) -> Result<Value> {
        self.send(WireCommand::Navigation {
            session: session.into(),
            previous: previous.into(),
        })
        .await
    }
    pub async fn loading(&self, session: &str, loader: &str) -> Result<Value> {
        self.send(WireCommand::Loading {
            session: session.into(),
            loader: loader.into(),
        })
        .await
    }
    pub async fn event(&self, session: &str) -> Result<Value> {
        self.send(WireCommand::Event {
            session: session.into(),
        })
        .await
    }
    pub async fn native_move(&self, x: i32, y: i32) -> Result<Value> {
        self.send(WireCommand::NativeMove { x, y }).await
    }
    pub async fn native_click(&self, x: i32, y: i32) -> Result<Value> {
        self.send(WireCommand::NativeClick { x, y }).await
    }
    pub async fn native_type(&self, text: &str) -> Result<Value> {
        self.send(WireCommand::NativeType { text: text.into() })
            .await
    }
    pub async fn evaluate(&self, session: &str, expression: &str) -> Result<Value> {
        let result = self
            .command(
                "Runtime.evaluate",
                json!({"expression":expression,"returnByValue":true,"awaitPromise":true}),
                Some(session),
            )
            .await?;
        ensure(
            result.get("exceptionDetails").is_none(),
            "browser_script_failed",
            502,
        )?;
        Ok(result["result"]["value"].clone())
    }
    pub async fn close(&self) -> Exit {
        self.0.stop.send_replace(true);
        self.wait_closed().await
    }
    /// Wait for automatic cancellation, failure, expiry, or explicit close.
    pub async fn wait_closed(&self) -> Exit {
        let mut closed = self.0.closed.clone();
        loop {
            if let Some(exit) = *closed.borrow_and_update() {
                return exit;
            }
            if closed.changed().await.is_err() {
                return Exit {
                    graceful: false,
                    supervisor_reaped: false,
                };
            }
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum WireCommand {
    Loading {
        session: String,
        loader: String,
    },
    Navigation {
        session: String,
        previous: String,
    },
    Event {
        session: String,
    },
    NativeMove {
        x: i32,
        y: i32,
    },
    NativeClick {
        x: i32,
        y: i32,
    },
    NativeType {
        text: String,
    },
    Cdp {
        method: String,
        params: Value,
        session: Option<String>,
    },
    Close,
}
fn frame(value: &impl Serialize, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(value)?;
    ensure(bytes.len() < limit as usize, "browser_frame_too_large", 413)?;
    bytes.push(b'\n');
    Ok(bytes)
}
async fn read_frame(reader: &mut (impl AsyncBufRead + Unpin), limit: u64) -> Result<Option<Value>> {
    let mut bytes = Vec::new();
    let count = reader.take(limit).read_until(b'\n', &mut bytes).await?;
    if count == 0 {
        return Ok(None);
    }
    ensure(bytes.last() == Some(&b'\n'), "browser_protocol_failed", 503)?;
    Ok(Some(serde_json::from_slice(&bytes)?))
}
async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    loop {
        if *receiver.borrow_and_update() || receiver.changed().await.is_err() {
            return;
        }
    }
}
async fn serve_child(
    child: &mut Child,
    mut requests: mpsc::Receiver<Request>,
    mut cancellation: watch::Receiver<bool>,
    mut ready: oneshot::Sender<Result<()>>,
) {
    let Some(stdout) = child.stdout.take() else {
        let _ = ready.send(Err(Error::new("browser_start_failed", 503)));
        return;
    };
    // Child::wait closes child.stdin before waiting. Own it separately so exit
    // monitoring cannot signal EOF during an otherwise healthy idle session.
    let Some(mut input) = child.stdin.take() else {
        let _ = ready.send(Err(Error::new("browser_start_failed", 503)));
        return;
    };
    let mut reader = BufReader::new(stdout);
    let startup = tokio::select! {
        biased;
        _ = cancelled(&mut cancellation) => return,
        _ = ready.closed() => return,
        result = timeout(START_TIMEOUT, read_frame(&mut reader, RESPONSE_BYTES)) => result,
    };
    if !matches!(startup, Ok(Ok(Some(ref value))) if value["ready"] == true) {
        let _ = ready.send(Err(Error::new("browser_start_failed", 503)));
        return;
    }
    if ready.send(Ok(())).is_err() {
        return;
    }
    let lifetime = Instant::now() + Duration::from_secs(1800);
    loop {
        let request = tokio::select! {
            biased;
            _ = cancelled(&mut cancellation) => break,
            _ = tokio::time::sleep_until(lifetime) => break,
            _ = tokio::time::sleep(Duration::from_secs(600)) => break,
            _ = child.wait() => break,
            request = requests.recv() => request,
        };
        let Some(mut request) = request else {
            break;
        };
        if request.reply.is_closed() {
            continue;
        }
        if Instant::now() >= request.deadline {
            let _ = request
                .reply
                .send(Err(Error::new("browser_command_timeout", 504)));
            continue;
        }
        let operation = async {
            input.write_all(&request.bytes).await?;
            let response = read_frame(&mut reader, RESPONSE_BYTES)
                .await?
                .ok_or_else(|| Error::new("browser_lost", 503))?;
            ensure(
                response.get("result").is_some() && response.get("error").is_none(),
                "browser_command_failed",
                502,
            )?;
            Ok(response["result"].clone())
        };
        let result = tokio::select! {
            biased;
            _ = cancelled(&mut cancellation) => break,
            _ = request.reply.closed() => break,
            result = timeout_at(request.deadline.min(lifetime), operation) => result.unwrap_or_else(|_| Err(Error::new("browser_command_timeout", 504))),
        };
        let failed = result.is_err();
        let _ = request.reply.send(result);
        if failed {
            break;
        }
    }
}
async fn stop_child(child: &mut Child) -> Exit {
    if let Some(mut input) = child.stdin.take() {
        let _ = timeout(
            Duration::from_millis(100),
            input.write_all(b"{\"action\":\"close\"}\n"),
        )
        .await;
    }
    if let Ok(Ok(status)) = timeout(Duration::from_secs(3), child.wait()).await {
        return Exit {
            graceful: status.success(),
            supervisor_reaped: true,
        };
    }
    let _ = child.start_kill();
    Exit {
        graceful: false,
        supervisor_reaped: child.wait().await.is_ok(),
    }
}

/// Hidden process entrypoint. Must run before Config::load or any database access.
pub async fn worker_main(mode: &str) -> Result<()> {
    worker::run(mode).await
}
