//! Runs only inside the private browser namespace, before platform config is loaded.
use super::{cdp::Cdp, *};
use std::{
    io,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    os::unix::net::UnixStream,
};
use tokio::net::{TcpListener, UnixStream as AsyncUnixStream};

struct Proxy(tokio::task::JoinHandle<()>);
impl Drop for Proxy {
    fn drop(&mut self) {
        self.0.abort();
    }
}
async fn proxy() -> Result<Proxy> {
    let listener = TcpListener::bind("127.0.0.1:17891").await?;
    Ok(Proxy(tokio::spawn(async move {
        let slots = Arc::new(Semaphore::new(32));
        let mut tasks = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok((mut client, _)) => if let Ok(slot) = slots.clone().try_acquire_owned() {
                        tasks.spawn(async move {
                            let _slot = slot;
                            let _ = timeout(Duration::from_secs(120), async {
                                let mut upstream = AsyncUnixStream::connect("/run/dispatch/egress.sock").await?;
                                tokio::io::copy_bidirectional(&mut client, &mut upstream).await
                            }).await;
                        });
                    },
                    Err(_) => break,
                },
                _ = tasks.join_next(), if !tasks.is_empty() => {},
            }
        }
    })))
}

/// The last of what the browser printed before it failed. Draining it continuously keeps
/// a full pipe from blocking the browser, and the tail is all a failure report needs.
#[derive(Clone, Default)]
pub(super) struct Notes(Arc<std::sync::Mutex<String>>);
impl Notes {
    const KEEP: usize = 2000;
    /// Keep draining `output` into the tail; the handle finishes when the output closes.
    pub(super) fn collect(
        &self,
        output: Option<impl tokio::io::AsyncRead + Unpin + Send + 'static>,
    ) -> Option<tokio::task::JoinHandle<()>> {
        let output = output?;
        let notes = self.clone();
        Some(tokio::spawn(async move {
            let mut reader = BufReader::new(output);
            let mut line = String::new();
            while reader.read_line(&mut line).await.is_ok_and(|read| read > 0) {
                if let Ok(mut kept) = notes.0.lock() {
                    kept.push_str(&line);
                    while kept.len() > Self::KEEP {
                        let over = kept.len() - Self::KEEP;
                        let cut = (over..=kept.len())
                            .find(|index| kept.is_char_boundary(*index))
                            .unwrap_or(kept.len());
                        kept.drain(..cut);
                    }
                }
                line.clear();
            }
        }))
    }
    pub(super) fn tail(&self) -> String {
        self.0
            .lock()
            .map(|kept| kept.trim().replace('\n', " | "))
            .unwrap_or_default()
    }
}
/// Report why this worker is stopping. Its standard error is closed, so the supervisor
/// only learns the reason from a frame on the pipe it already reads.
async fn report(error: &Error, notes: &Notes) {
    let mut output = tokio::io::stdout();
    let report = format!("{}\n", json!({"error":error.code,"detail":notes.tail()}));
    let _ = output.write_all(report.as_bytes()).await;
    let _ = output.flush().await;
}
pub(super) async fn run(mode: &str) -> Result<()> {
    let notes = Notes::default();
    let result = serve(mode, &notes).await;
    if let Err(error) = &result {
        report(error, &notes).await;
    }
    result
}
async fn serve(mode: &str, notes: &Notes) -> Result<()> {
    ensure(
        ["headless", "windowed"].contains(&mode),
        "invalid_browser_mode",
        400,
    )?;
    ensure(
        std::env::var("HOME").as_deref() == Ok("/profile")
            && !Path::new("/home").exists()
            && !Path::new("/root").exists()
            && std::env::var_os("DISPATCH_STATE_ROOT").is_none(),
        "browser_isolation_required",
        503,
    )?;
    for namespace in ["pid", "net", "mnt", "ipc", "uts", "user"] {
        let host = std::env::var(format!("DISPATCH_HOST_{namespace}")).unwrap_or_default();
        ensure(
            !host.is_empty()
                && fs::read_link(format!("/proc/self/ns/{namespace}"))?.to_string_lossy() != host,
            "browser_isolation_required",
            503,
        )?;
    }
    for name in [
        "BrowserOSServer",
        "BrowserClawServer",
        "browseros_extensions",
    ] {
        ensure(
            !Path::new("/browser").join(name).exists(),
            "browser_agent_server_forbidden",
            503,
        )?;
    }
    let _proxy = proxy().await?;
    let mut display = if mode == "windowed" {
        Some(
            Command::new("/usr/bin/Xvfb")
                .args([
                    ":99",
                    "-screen",
                    "0",
                    "1024x768x24",
                    "-nolisten",
                    "tcp",
                    "-noreset",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()?,
        )
    } else {
        None
    };
    if display.is_some() {
        timeout(Duration::from_secs(10), async {
            while !Path::new("/tmp/.X11-unix/X99").exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| Error::new("browser_display_failed", 503))?;
    }
    let (mut child, mut cdp) = browser(mode, notes).await?;
    cdp.command("Browser.getTabs", json!({}), None).await?;
    let mut input = BufReader::new(tokio::io::stdin());
    let mut output = tokio::io::stdout();
    output.write_all(b"{\"ready\":true}\n").await?;
    output.flush().await?;
    loop {
        let value = tokio::select! {
            _ = child.wait() => return Err(Error::new("browser_lost", 503)),
            value = read_frame(&mut input, COMMAND_BYTES) => value?,
        };
        let Some(value) = value else {
            break;
        };
        let result = match serde_json::from_value::<WireCommand>(value)? {
            WireCommand::Close => break,
            WireCommand::Cdp {
                method,
                params,
                session,
            } => cdp.command(&method, params, session.as_deref()).await,
            WireCommand::Loading { session, loader } => Ok(cdp.loading(&session, &loader)),
            WireCommand::Navigation { session, previous } => {
                cdp.navigation(&session, &previous).await
            }
            WireCommand::Event { session } => cdp.event(&session).await,
            WireCommand::NativeMove { x, y } => {
                ensure(mode == "windowed", "browser_interaction_required", 409)?;
                super::native::move_pointer(x, y)
            }
            WireCommand::NativeClick { x, y } => {
                ensure(mode == "windowed", "browser_interaction_required", 409)?;
                super::native::click(x, y)
            }
            WireCommand::NativeType { text } => {
                ensure(mode == "windowed", "browser_interaction_required", 409)?;
                super::native::type_text(&text)
            }
        };
        let failed = result.is_err();
        let response = match result {
            Ok(value) => json!({"result":value}),
            Err(_) => json!({"error":"browser_command_failed"}),
        };
        output.write_all(&frame(&response, RESPONSE_BYTES)?).await?;
        output.flush().await?;
        if failed {
            return Err(Error::new("browser_command_failed", 502));
        }
    }

    cdp.command("Browser.close", json!({}), None).await?;
    let status = timeout(Duration::from_secs(5), child.wait())
        .await
        .map_err(|_| Error::new("browser_close_failed", 503))??;
    ensure(status.success(), "browser_close_failed", 503)?;
    if let Some(display) = display.as_mut() {
        display.kill().await?;
        display.wait().await?;
    }
    Ok(())
}

fn pipe_descriptor(socket: &UnixStream) -> Result<OwnedFd> {
    // Keep our source away from stdio and the destination slots in pre_exec.
    let fd = unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
    if fd < 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}
async fn browser(mode: &str, notes: &Notes) -> Result<(tokio::process::Child, Cdp)> {
    let (client, server) = UnixStream::pair()?;
    let descriptor = pipe_descriptor(&server)?;
    let mut command = Command::new("/browser/browseros");
    command.args([
        "--user-data-dir=/profile",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-pipe",
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        "--disable-browseros-server",
        "--disable-browseros-server-updater",
        "--disable-browseros-extensions",
        "--browseros-disable-url-overrides",
        "--disable-extensions",
        "--disable-component-update",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-breakpad",
        "--disable-crash-reporter",
        "--password-store=basic",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--window-size=1024,768",
        "--lang=en-US",
        "--proxy-server=http://127.0.0.1:17891",
        "--proxy-bypass-list=<-loopback>",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--renderer-process-limit=4",
    ]);
    if mode == "headless" {
        command.arg("--headless=new");
    }
    command
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // Kept and drained, so a failed start can say what the browser complained about.
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Only async-signal-safe syscalls run after fork. Browser CDP reads fd 3 and writes fd 4.
    unsafe {
        command.pre_exec(move || {
            for target in [3, 4] {
                if libc::dup2(descriptor.as_raw_fd(), target) < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    notes.collect(child.stderr.take());
    drop(command);
    drop(server);
    Ok((child, Cdp::new(client)?))
}
