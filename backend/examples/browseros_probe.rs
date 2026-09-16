//! Opt-in BrowserOS host proof. Never selected by the platform's provider driver.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    error::Error,
    fs, io,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{
            fs::{MetadataExt, PermissionsExt},
            net::UnixStream,
        },
    },
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;
const MAX_FRAME: u64 = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);
const FIXTURE: &str = r#"<!doctype html><meta charset="utf-8"><title>Dispatch BrowserOS fixture</title>
<style>body{font:20px sans-serif;padding:40px}input,button{font:inherit;padding:12px}</style>
<h1>Scripted browser check</h1><form id="login"><input id="account" aria-label="Account"><button>Continue</button></form><pre id="result"></pre>
<script>window.events=[];account.addEventListener('input',e=>events.push(e.isTrusted));login.onsubmit=e=>{e.preventDefault();result.textContent=JSON.stringify({account:account.value,employees:[{id:'fixture-1',hours:8}]})}</script>"#;

fn require(ok: bool, message: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(io::Error::other(message).into())
    }
}
fn trusted(path: &Path) -> Result<PathBuf> {
    let path = fs::canonicalize(path)?;
    require(path.is_file(), "Executable must be a regular file")?;
    for entry in path.ancestors() {
        let stat = fs::metadata(entry)?;
        require(
            stat.uid() == 0 && stat.mode() & 0o022 == 0,
            "Browser and sandbox must be root-owned, including parents",
        )?;
    }
    require(
        fs::metadata(&path)?.mode() & 0o111 != 0,
        "Executable permission required",
    )?;
    Ok(path)
}

/// Serialized, bounded CDP transport. The descriptor is private to one browser.
/// Unexpected events are consumed while waiting; commands never overlap.
struct Cdp {
    socket: BufReader<tokio::net::UnixStream>,
    next: u64,
}
impl Cdp {
    fn new(socket: UnixStream) -> Result<Self> {
        socket.set_nonblocking(true)?;
        Ok(Self {
            socket: BufReader::new(tokio::net::UnixStream::from_std(socket)?),
            next: 0,
        })
    }
    async fn command(
        &mut self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value> {
        self.next += 1;
        let id = self.next;
        let mut message = json!({"id":id,"method":method,"params":params});
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        let mut bytes = serde_json::to_vec(&message)?;
        require(bytes.len() < MAX_FRAME as usize, "CDP command too large")?;
        bytes.push(0);
        tokio::time::timeout(TIMEOUT, async {
            self.socket.get_mut().write_all(&bytes).await?;
            loop {
                let mut bytes = Vec::new();
                let count = (&mut self.socket)
                    .take(MAX_FRAME)
                    .read_until(0, &mut bytes)
                    .await?;
                require(count > 0, "Browser control pipe closed")?;
                require(bytes.last() == Some(&0), "CDP response exceeds frame limit")?;
                let value: Value = serde_json::from_slice(&bytes[..bytes.len() - 1])?;
                if value["id"] != id {
                    continue;
                }
                if let Some(error) = value.get("error") {
                    return Err(io::Error::other(format!("{method}: {error}")).into());
                }
                return Ok(value["result"].clone());
            }
        })
        .await
        .map_err(|_| io::Error::other(format!("CDP command timed out: {method}")))?
    }
    async fn evaluate(&mut self, session: &str, expression: &str) -> Result<Value> {
        let value = self
            .command(
                "Runtime.evaluate",
                json!({"expression":expression,"returnByValue":true,"awaitPromise":true}),
                Some(session),
            )
            .await?;
        require(
            value.get("exceptionDetails").is_none(),
            "Browser script failed",
        )?;
        Ok(value["result"]["value"].clone())
    }
    async fn wait(&mut self, session: &str, expression: &str) -> Result<Value> {
        tokio::time::timeout(TIMEOUT, async {
            loop {
                let value = self.evaluate(session, expression).await?;
                if value != false && !value.is_null() {
                    return Ok(value);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .map_err(|_| io::Error::other(format!("Page condition timed out: {expression}")))?
    }
}

fn pipe_descriptor(socket: &UnixStream) -> Result<OwnedFd> {
    // Keep our source away from stdio and the destination slots in pre_exec.
    let fd = unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
    if fd < 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}
async fn browser(mode: &str) -> Result<(tokio::process::Child, Cdp)> {
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
    ]);
    if mode == "headless" {
        command.arg("--headless=new");
    }
    command
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
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
    let child = command.spawn()?;
    drop(command);
    drop(server);
    Ok((child, Cdp::new(client)?))
}

async fn fixture() -> Result<tokio::task::JoinHandle<()>> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:17892").await?;
    Ok(tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut request = [0; 4096];
                if tokio::time::timeout(Duration::from_secs(2), stream.read(&mut request))
                    .await
                    .is_err()
                {
                    return;
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{FIXTURE}",
                    FIXTURE.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    }))
}
fn processes() -> Result<Value> {
    let mut names = Vec::new();
    let mut rss = 0u64;
    for entry in fs::read_dir("/proc")? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().parse::<u32>().is_err() {
            continue;
        }
        let Ok(name) = fs::read_to_string(entry.path().join("comm")) else {
            continue;
        };
        let name = name.trim().to_owned();
        require(
            [
                "bwrap",
                "browseros_probe",
                "browseros",
                "chrome_crashpad",
                "Xvfb",
            ]
            .contains(&name.as_str()),
            &format!("Unexpected sandbox process: {name}"),
        )?;
        if let Ok(status) = fs::read_to_string(entry.path().join("status"))
            && let Some(line) = status.lines().find(|line| line.starts_with("VmRSS:"))
        {
            rss += line
                .split_whitespace()
                .nth(1)
                .and_then(|n| n.parse::<u64>().ok())
                .unwrap_or(0);
        }
        names.push(name);
    }
    Ok(json!({"names":names,"summedRssKiB":rss}))
}
async fn worker(mode: &str) -> Result<()> {
    let started = Instant::now();
    require(
        std::env::var("HOME")? == "/profile",
        "Private profile required",
    )?;
    require(
        !Path::new("/home").exists() && !Path::new("/root").exists(),
        "Host home must not be mounted",
    )?;
    require(
        !Path::new("/browser/BrowserOSServer").exists(),
        "Bundled agent server must be absent",
    )?;
    for namespace in ["pid", "net", "mnt"] {
        let host = std::env::var(format!("DISPATCH_HOST_{namespace}"))?;
        require(
            fs::read_link(format!("/proc/self/ns/{namespace}"))?.to_string_lossy() != host,
            "Separate namespaces required",
        )?;
    }
    require(
        std::net::TcpStream::connect_timeout(&"1.1.1.1:443".parse()?, Duration::from_millis(200))
            .is_err(),
        "External network must be unavailable in this probe",
    )?;
    let mut display = None;
    if mode == "windowed" {
        display = Some(
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
        );
        tokio::time::timeout(TIMEOUT, async {
            while !Path::new("/tmp/.X11-unix/X99").exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await?;
    }
    let fixture = fixture().await?;
    let (mut child, mut cdp) = browser(mode).await?;
    let version = cdp.command("Browser.getVersion", json!({}), None).await?;
    // These are BrowserOS extensions, not stock Chrome's tab protocol.
    let created = cdp
        .command(
            "Browser.createTab",
            json!({"url":"http://127.0.0.1:17892/","background":false}),
            None,
        )
        .await?;
    let tabs = cdp.command("Browser.getTabs", json!({}), None).await?;
    let target = created["tab"]["targetId"]
        .as_str()
        .ok_or("BrowserOS target missing")?;
    require(
        tabs["tabs"]
            .as_array()
            .is_some_and(|tabs| tabs.iter().any(|tab| tab["targetId"] == target)),
        "BrowserOS tab discovery failed",
    )?;
    let attach = cdp
        .command(
            "Target.attachToTarget",
            json!({"targetId":target,"flatten":true}),
            None,
        )
        .await?;
    let session = attach["sessionId"].as_str().ok_or("CDP session missing")?;
    cdp.command("Page.bringToFront", json!({}), Some(session))
        .await?;
    cdp.wait(
        session,
        "document.readyState === 'complete' && document.querySelector('#account') !== null",
    )
    .await?;
    require(
        cdp.evaluate(session, "localStorage.getItem('dispatch-proof')")
            .await?
            .is_null(),
        "Profile leaked between runs",
    )?;
    cdp.evaluate(session, "localStorage.setItem('dispatch-proof','private'); document.querySelector('#account').focus(); true").await?;
    cdp.command(
        "Input.insertText",
        json!({"text":"00Rust !?"}),
        Some(session),
    )
    .await?;
    require(
        cdp.evaluate(session, "document.querySelector('#account').value")
            .await?
            == "00Rust !?",
        "Typed value mismatch",
    )?;
    cdp.evaluate(
        session,
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))",
    )
    .await?;
    let point = cdp.evaluate(session, "(()=>{const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()").await?;
    for kind in ["mousePressed", "mouseReleased"] {
        cdp.command(
            "Input.dispatchMouseEvent",
            json!({"type":kind,"button":"left","clickCount":1,"x":point["x"],"y":point["y"]}),
            Some(session),
        )
        .await?;
    }
    let result = cdp
        .wait(
            session,
            "document.querySelector('#result').textContent || false",
        )
        .await?;
    let result: Value = serde_json::from_str(result.as_str().ok_or("Fixture result missing")?)?;
    require(
        result == json!({"account":"00Rust !?","employees":[{"id":"fixture-1","hours":8}]}),
        "Scripted form or extraction failed",
    )?;
    require(
        cdp.evaluate(session, "events.length > 0 && events.every(Boolean)")
            .await?
            == true,
        "Trusted browser input events required",
    )?;
    let screenshot = cdp
        .command(
            "Page.captureScreenshot",
            json!({"format":"png"}),
            Some(session),
        )
        .await?;
    let png = STANDARD.decode(screenshot["data"].as_str().ok_or("Screenshot missing")?)?;
    require(
        png.len() > 1024 && png.starts_with(b"\x89PNG\r\n\x1a\n"),
        "Invalid screenshot",
    )?;
    fs::write("/probe/screenshot.png", &png)?;
    cdp.command(
        "Page.navigate",
        json!({"url":"chrome://sandbox"}),
        Some(session),
    )
    .await?;
    let sandbox = cdp.wait(session, "document.body && document.body.innerText.includes('Seccomp') && document.body.innerText").await?;
    let sandbox_text = sandbox.as_str().ok_or("Sandbox status missing")?;
    for feature in [
        "PID namespaces",
        "Network namespaces",
        "Seccomp-BPF sandbox",
    ] {
        let line = sandbox_text
            .lines()
            .find(|line| line.starts_with(feature))
            .ok_or("Sandbox feature missing")?;
        require(
            line.contains("Yes"),
            &format!("Sandbox feature disabled: {feature}"),
        )?;
    }
    let processes = processes()?;
    if Path::new("/probe/cancel").exists() {
        fs::write("/probe/ready", "ready")?;
        std::future::pending::<()>().await;
    }
    cdp.command("Browser.close", json!({}), None).await?;
    let status = tokio::time::timeout(Duration::from_secs(10), child.wait()).await??;
    require(status.success(), "Browser exited unsuccessfully")?;
    if let Some(mut display) = display {
        display.kill().await?;
        display.wait().await?;
    }
    fixture.abort();
    fs::write(
        "/probe/result.json",
        serde_json::to_vec_pretty(&json!({
            "mode":mode,"version":version,"elapsedMs":started.elapsed().as_millis(),
            "browserosCommands":true,"scriptedForm":true,"extraction":true,"trustedCdpInput":true,
            "freshProfile":true,"privateNamespaces":true,"externalNetworkBlocked":true,
            "screenshotBytes":png.len(),"chromiumSandbox":sandbox_text,"processes":processes,"cleanShutdown":true
        }))?,
    )?;
    Ok(())
}

fn sandbox_command(browser: &Path, bwrap: &Path, run: &Path, mode: &str) -> Result<Command> {
    let executable = fs::canonicalize(std::env::current_exe()?)?;
    let mut command = Command::new(bwrap);
    command.args([
        "--die-with-parent",
        "--new-session",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-net",
        "--unshare-ipc",
        "--unshare-uts",
        "--cap-drop",
        "ALL",
        "--ro-bind",
        "/usr",
        "/usr",
        "--symlink",
        "usr/bin",
        "/bin",
        "--symlink",
        "usr/lib",
        "/lib",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
    ]);
    if Path::new("/usr/lib64").exists() {
        command.args(["--symlink", "usr/lib64", "/lib64"]);
    }
    for path in [
        "/etc/fonts",
        "/etc/ssl",
        "/etc/passwd",
        "/etc/group",
        "/etc/nsswitch.conf",
    ] {
        if Path::new(path).exists() {
            command.args(["--ro-bind", path, path]);
        }
    }
    command
        .arg("--ro-bind")
        .arg(browser.parent().ok_or("Browser directory missing")?)
        .arg("/browser")
        .arg("--ro-bind")
        .arg(executable)
        .arg("/runtime/browseros_probe")
        .arg("--bind")
        .arg(run.join("profile"))
        .arg("/profile")
        .arg("--bind")
        .arg(run.join("output"))
        .arg("/probe")
        .args([
            "--clearenv",
            "--setenv",
            "PATH",
            "/usr/bin:/bin",
            "--setenv",
            "HOME",
            "/profile",
            "--setenv",
            "XDG_CONFIG_HOME",
            "/profile/config",
            "--setenv",
            "XDG_CACHE_HOME",
            "/profile/cache",
            "--setenv",
            "LANG",
            "C.UTF-8",
            "--setenv",
            "DISPLAY",
            ":99",
        ]);
    for namespace in ["pid", "net", "mnt"] {
        command
            .arg("--setenv")
            .arg(format!("DISPATCH_HOST_{namespace}"))
            .arg(fs::read_link(format!("/proc/self/ns/{namespace}"))?);
    }
    command
        .args([
            "--chdir",
            "/probe",
            "/runtime/browseros_probe",
            "--worker",
            mode,
        ])
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(fs::File::create(
            run.join("output/stderr.log"),
        )?))
        .kill_on_drop(true);
    Ok(command)
}

async fn probe(
    browser: &Path,
    bwrap: &Path,
    mode: &str,
    cancel: bool,
    output: &Path,
) -> Result<Value> {
    let run = tempfile::Builder::new()
        .prefix("dispatch-browseros-")
        .tempdir()?;
    for path in [run.path().join("profile"), run.path().join("output")] {
        fs::create_dir(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
    }
    if cancel {
        fs::write(run.path().join("output/cancel"), "cancel")?;
    }
    let mut child = sandbox_command(browser, bwrap, run.path(), mode)?.spawn()?;
    if cancel {
        let ready = run.path().join("output/ready");
        let ready = tokio::time::timeout(Duration::from_secs(60), async {
            while !ready.exists() {
                if child.try_wait()?.is_some() {
                    return Err(io::Error::other("Cancellation fixture exited before ready"));
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Ok::<_, io::Error>(())
        })
        .await;
        if child.try_wait()?.is_none() {
            child.kill().await?;
        }
        child.wait().await?;
        ready??;
        return Ok(json!({"mode":mode,"forcedCancellation":true,"supervisorReaped":true}));
    }
    let status = match tokio::time::timeout(Duration::from_secs(60), child.wait()).await {
        Ok(status) => status?,
        Err(error) => {
            child.kill().await?;
            child.wait().await?;
            return Err(error.into());
        }
    };
    let mut log = fs::File::open(run.path().join("output/stderr.log"))?;
    let length = log.metadata()?.len().min(64 * 1024);
    std::io::Seek::seek(&mut log, std::io::SeekFrom::End(-(length as i64)))?;
    let mut diagnostic = String::new();
    std::io::Read::read_to_string(&mut log, &mut diagnostic)?;
    require(
        status.success(),
        &format!("{mode} probe failed: {diagnostic}"),
    )?;
    let report: Value = serde_json::from_slice(&fs::read(run.path().join("output/result.json"))?)?;
    fs::copy(
        run.path().join("output/screenshot.png"),
        output.join(format!("{mode}.png")),
    )?;
    Ok(report)
}
#[tokio::main]
async fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() == 2 && args[0] == "--worker" {
        require(
            ["headless", "windowed"].contains(&args[1].as_str()),
            "Invalid mode",
        )?;
        return worker(&args[1]).await;
    }
    require(
        args.len() == 3,
        "Usage: browseros_probe /absolute/browseros /absolute/bwrap /new/output-directory",
    )?;
    let browser = trusted(Path::new(&args[0]))?;
    let bwrap = trusted(Path::new(&args[1]))?;
    require(
        browser.file_name().is_some_and(|name| name == "browseros"),
        "BrowserOS executable required",
    )?;
    let output = Path::new(&args[2]);
    require(output.is_absolute(), "Absolute output directory required")?;
    fs::create_dir(output)?;
    fs::set_permissions(output, fs::Permissions::from_mode(0o700))?;
    let headless = probe(&browser, &bwrap, "headless", false, output).await?;
    let windowed = probe(&browser, &bwrap, "windowed", false, output).await?;
    let cancelled = probe(&browser, &bwrap, "headless", true, output).await?;
    let report = json!({"schema":1,"browser":browser,"headless":headless,"windowed":windowed,"cancellation":cancelled});
    fs::write(
        output.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn transport_handles_fragmented_events_and_response() -> Result<()> {
        let (client, server) = UnixStream::pair()?;
        server.set_nonblocking(true)?;
        let mut server = BufReader::new(tokio::net::UnixStream::from_std(server)?);
        let task = tokio::spawn(async move {
            let mut request = Vec::new();
            server.read_until(0, &mut request).await?;
            let value: Value = serde_json::from_slice(&request[..request.len() - 1])?;
            require(value["sessionId"] == "page-1", "Session not forwarded")?;
            server
                .get_mut()
                .write_all(b"{\"method\":\"Page.loadEventFired\"}\0{\"id\":1,")
                .await?;
            server
                .get_mut()
                .write_all(b"\"result\":{\"ok\":true}}\0")
                .await?;
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        });
        let mut cdp = Cdp::new(client)?;
        assert_eq!(
            cdp.command("Page.enable", json!({}), Some("page-1"))
                .await?,
            json!({"ok":true})
        );
        task.await??;
        Ok(())
    }
    #[tokio::test]
    async fn transport_rejects_eof_and_oversized_frames() -> Result<()> {
        for bytes in [Vec::new(), vec![b' '; MAX_FRAME as usize]] {
            let (client, server) = UnixStream::pair()?;
            server.set_nonblocking(true)?;
            let mut server = BufReader::new(tokio::net::UnixStream::from_std(server)?);
            let task = tokio::spawn(async move {
                let mut request = Vec::new();
                let _ = server.read_until(0, &mut request).await;
                let _ = server.get_mut().write_all(&bytes).await;
            });
            assert!(
                Cdp::new(client)?
                    .command("Browser.getVersion", json!({}), None)
                    .await
                    .is_err()
            );
            task.await?;
        }
        Ok(())
    }
}
