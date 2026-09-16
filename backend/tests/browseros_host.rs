//! Synthetic acceptance checks against the same worker binary shipped in artifacts.
use base64::{Engine, engine::general_purpose::STANDARD};
use dispatch_backend::core::browsers::browseros::{Mode, NetworkPolicy, Runtime, Session};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::{Instant, timeout},
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
const FIXTURE: &str = r#"<!doctype html><meta charset="utf-8"><title>Dispatch BrowserOS fixture</title>
<style>body{font:20px sans-serif;padding:40px}input,button{font:inherit;padding:12px}</style>
<h1>Scripted browser check</h1><form id="login"><input id="account" aria-label="Account"><button>Continue</button></form><pre id="result"></pre>
<script>window.events=[];account.addEventListener('input',e=>events.push(e.isTrusted));login.onsubmit=e=>{e.preventDefault();result.textContent=JSON.stringify({account:account.value,employees:[{id:'fixture-1',hours:8}]})}</script>"#;

struct Fixture {
    port: u16,
    hits: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fixture {
    async fn start() -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        let task = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((mut stream, _)) = accepted else { break; };
                        counter.fetch_add(1, Ordering::SeqCst);
                        tasks.spawn(async move {
                            let mut request = [0; 4096];
                            let _ = timeout(Duration::from_secs(2), stream.read(&mut request)).await;
                            let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{FIXTURE}", FIXTURE.len());
                            let _ = stream.write_all(reply.as_bytes()).await;
                        });
                    },
                    _ = tasks.join_next(), if !tasks.is_empty() => {},
                }
            }
        });
        Ok(Self { port, hits, task })
    }
    fn policy(&self) -> NetworkPolicy {
        NetworkPolicy::Fixture(self.port.try_into().unwrap())
    }
    fn url(&self) -> String {
        format!("http://fixture.dispatch.invalid:{}/", self.port)
    }
}
fn runtime(root: &Path, executable: &Path) -> Result<Runtime> {
    let release: Value =
        serde_json::from_str(include_str!("../../tooling/browseros-release.json"))?;
    let browser = PathBuf::from(format!(
        "/opt/dispatch-browseros/{}/browseros",
        release["version"].as_str().unwrap()
    ));
    let sandbox = std::env::var_os("DISPATCH_BWRAP_EXECUTABLE")
        .map(PathBuf::from)
        .unwrap_or_else(|| "/usr/local/libexec/dispatch-dev/bwrap".into());
    Ok(Runtime::new(
        &browser,
        &sandbox,
        executable,
        &root.join("runs"),
        2,
    )?)
}
async fn wait(session: &Session, page: &str, expression: &str) -> Result<Value> {
    Ok(timeout(Duration::from_secs(10), async {
        loop {
            let value = session.evaluate(page, expression).await?;
            if value != false && !value.is_null() {
                return Ok::<_, dispatch_backend::core::Error>(value);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await??)
}
async fn page(session: &Session, url: &str) -> Result<String> {
    let created = session
        .command(
            "Browser.createTab",
            json!({"url":url,"background":false}),
            None,
        )
        .await?;
    let target = created["tab"]["targetId"].as_str().unwrap();
    let tabs = session.command("Browser.getTabs", json!({}), None).await?;
    assert!(
        tabs["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tab| tab["targetId"] == target)
    );
    let attached = session
        .command(
            "Target.attachToTarget",
            json!({"targetId":target,"flatten":true}),
            None,
        )
        .await?;
    let page = attached["sessionId"].as_str().unwrap().to_owned();
    session
        .command("Page.bringToFront", json!({}), Some(&page))
        .await?;
    wait(
        session,
        &page,
        "document.readyState === 'complete' && document.querySelector('#account') !== null",
    )
    .await?;
    Ok(page)
}
async fn scripted_form(session: &Session, page: &str) -> Result<()> {
    session
        .evaluate(page, "document.querySelector('#account').focus(); true")
        .await?;
    session
        .command("Input.insertText", json!({"text":"00Rust !?"}), Some(page))
        .await?;
    assert_eq!(session.evaluate(page, "account.value").await?, "00Rust !?");
    session.evaluate(page, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))").await?;
    let point = session.evaluate(page, "(()=>{const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()").await?;
    for kind in ["mousePressed", "mouseReleased"] {
        session
            .command(
                "Input.dispatchMouseEvent",
                json!({"type":kind,"button":"left","clickCount":1,"x":point["x"],"y":point["y"]}),
                Some(page),
            )
            .await?;
    }
    let result = wait(
        session,
        page,
        "document.querySelector('#result').textContent || false",
    )
    .await?;
    assert_eq!(
        serde_json::from_str::<Value>(result.as_str().unwrap())?,
        json!({"account":"00Rust !?","employees":[{"id":"fixture-1","hours":8}]})
    );
    assert_eq!(
        session
            .evaluate(page, "events.length > 0 && events.every(Boolean)")
            .await?,
        true
    );
    let screenshot = session
        .command(
            "Page.captureScreenshot",
            json!({"format":"png"}),
            Some(page),
        )
        .await?;
    let png = STANDARD.decode(screenshot["data"].as_str().unwrap())?;
    assert!(png.len() > 1024 && png.starts_with(b"\x89PNG\r\n\x1a\n"));
    Ok(())
}
async fn sandbox_status(session: &Session, page: &str) -> Result<()> {
    session
        .command(
            "Page.navigate",
            json!({"url":"chrome://sandbox"}),
            Some(page),
        )
        .await?;
    let status = wait(
        session,
        page,
        "document.body && document.body.innerText.includes('Seccomp') && document.body.innerText",
    )
    .await?;
    for feature in [
        "PID namespaces",
        "Network namespaces",
        "Seccomp-BPF sandbox",
    ] {
        assert!(
            status
                .as_str()
                .unwrap()
                .lines()
                .find(|line| line.starts_with(feature))
                .unwrap()
                .contains("Yes")
        );
    }
    Ok(())
}
fn descendants(pid: u32) -> Vec<u32> {
    let mut all = vec![pid];
    if let Ok(children) = fs::read_to_string(format!("/proc/{pid}/task/{pid}/children")) {
        for child in children.split_whitespace().filter_map(|s| s.parse().ok()) {
            all.extend(descendants(child));
        }
    }
    all
}
fn snapshot(session: &Session) -> Vec<(u32, String)> {
    descendants(session.process_id())
        .into_iter()
        .filter_map(|pid| {
            let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            let fields = stat
                .rsplit_once(')')?
                .1
                .split_whitespace()
                .collect::<Vec<_>>();
            Some((pid, fields[19].into()))
        })
        .collect()
}
async fn gone(processes: &[(u32, String)]) -> Result<()> {
    timeout(Duration::from_secs(5), async {
        loop {
            let alive = processes.iter().any(|(pid, started)| {
                let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
                    return false;
                };
                let fields = stat
                    .rsplit_once(')')
                    .unwrap()
                    .1
                    .split_whitespace()
                    .collect::<Vec<_>>();
                fields[0] != "Z" && fields[19] == started
            });
            if !alive {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await?;
    Ok(())
}
fn process_isolation(session: &Session) -> Result<()> {
    let mut found_worker = false;
    for pid in descendants(session.process_id()) {
        let Ok(name) = fs::read_to_string(format!("/proc/{pid}/comm")) else {
            continue;
        };
        assert!(
            [
                "bwrap",
                "dispatch-backen",
                "browseros",
                "chrome_crashpad",
                "Xvfb"
            ]
            .contains(&name.trim()),
            "Unexpected process {name}"
        );
        if name.trim() == "dispatch-backen" {
            found_worker = true;
            for namespace in ["pid", "net", "mnt", "ipc", "uts", "user"] {
                assert_ne!(
                    fs::read_link(format!("/proc/{pid}/ns/{namespace}"))?,
                    fs::read_link(format!("/proc/self/ns/{namespace}"))?
                );
            }
        }
    }
    assert!(found_worker);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires pinned BrowserOS, Xvfb and trusted bubblewrap; run npm run test:browseros"]
async fn persistent_profiles_isolation_egress_and_lifecycle() -> Result<()> {
    let root = tempfile::tempdir()?;
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700))?;
    let binary = root.path().join("dispatch-backend");
    fs::copy(env!("CARGO_BIN_EXE_dispatch-backend"), &binary)?;
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700))?;
    let forbidden = root.path().join("must-not-initialize-platform-state");
    let unconfined = std::process::Command::new(&binary)
        .args(["browseros-worker", "headless"])
        .env_clear()
        .env("HOME", "/profile")
        .env("DISPATCH_STATE_ROOT", &forbidden)
        .output()?;
    assert!(!unconfined.status.success());
    assert!(String::from_utf8(unconfined.stderr)?.contains("browser_isolation_required"));
    assert!(!forbidden.exists());
    let runtime = Arc::new(runtime(root.path(), &binary)?);
    let independent = self::runtime(root.path(), &binary)?;
    let fixture = Fixture::start().await?;
    let denied = Fixture::start().await?;
    let profile = root.path().join("dsp-a/browseros");
    let other_profile = root.path().join("dsp-b/browseros");
    let (first, other) = tokio::join!(
        runtime.start(&profile, Mode::Headless, fixture.policy()),
        runtime.start(&other_profile, Mode::Headless, fixture.policy())
    );
    let first = first?;
    let other = other?;
    assert_eq!(
        runtime
            .start(
                &root.path().join("dsp-c/browseros"),
                Mode::Headless,
                fixture.policy()
            )
            .await
            .err()
            .unwrap()
            .code,
        "browser_capacity_busy"
    );
    assert_eq!(
        independent
            .start(&profile, Mode::Headless, fixture.policy())
            .await
            .err()
            .unwrap()
            .code,
        "browser_profile_busy"
    );
    process_isolation(&first)?;
    let first_page = page(&first, &fixture.url()).await?;
    let other_page = page(&other, &fixture.url()).await?;
    assert_eq!(
        first
            .evaluate(&first_page, "localStorage.getItem('owner')")
            .await?,
        Value::Null
    );
    first.evaluate(&first_page, "localStorage.setItem('owner','dsp-a');document.cookie='persist=rust; Max-Age=3600; SameSite=Lax';true").await?;
    assert_eq!(
        other
            .evaluate(&other_page, "localStorage.getItem('owner')")
            .await?,
        Value::Null
    );
    assert_eq!(other.evaluate(&other_page, "document.cookie").await?, "");
    scripted_form(&first, &first_page).await?;
    // Both host-loopback access and a second synthetic port must be denied.
    for url in [
        format!("http://127.0.0.1:{}/", denied.port),
        format!("http://fixture.dispatch.invalid:{}/", denied.port),
    ] {
        let expression = format!(
            "fetch({}).then(()=> 'unexpected').catch(()=> 'blocked')",
            serde_json::to_string(&url)?
        );
        assert_eq!(first.evaluate(&first_page, &expression).await?, "blocked");
    }
    assert_eq!(denied.hits.load(Ordering::SeqCst), 0);
    assert!(fixture.hits.load(Ordering::SeqCst) >= 2);
    assert_eq!(
        first
            .command(
                "Runtime.evaluate",
                json!({"expression":"x".repeat(65536)}),
                Some(&first_page)
            )
            .await
            .unwrap_err()
            .code,
        "browser_frame_too_large"
    );
    sandbox_status(&first, &first_page).await?;
    let before = snapshot(&first);
    let exit = first.close().await;
    assert!(exit.graceful && exit.supervisor_reaped);
    gone(&before).await?;

    let windowed = runtime
        .start(&profile, Mode::Windowed, fixture.policy())
        .await?;
    process_isolation(&windowed)?;
    let windowed_page = page(&windowed, &fixture.url()).await?;
    assert_eq!(
        windowed
            .evaluate(&windowed_page, "localStorage.getItem('owner')")
            .await?,
        "dsp-a"
    );
    assert!(
        windowed
            .evaluate(&windowed_page, "document.cookie")
            .await?
            .as_str()
            .unwrap()
            .contains("persist=rust")
    );
    scripted_form(&windowed, &windowed_page).await?;
    windowed
        .command(
            "Page.navigate",
            json!({"url":"chrome://sandbox"}),
            Some(&windowed_page),
        )
        .await?;
    let sandbox = wait(
        &windowed,
        &windowed_page,
        "document.body && document.body.innerText.includes('Seccomp') && document.body.innerText",
    )
    .await?;
    for feature in [
        "PID namespaces",
        "Network namespaces",
        "Seccomp-BPF sandbox",
    ] {
        assert!(
            sandbox
                .as_str()
                .unwrap()
                .lines()
                .find(|line| line.starts_with(feature))
                .unwrap()
                .contains("Yes")
        );
    }
    let before = snapshot(&windowed);
    assert!(windowed.close().await.graceful);
    gone(&before).await?;
    assert_eq!(
        other
            .evaluate(&other_page, "localStorage.getItem('owner')")
            .await?,
        Value::Null
    );
    assert!(other.close().await.graceful);
    assert_eq!(fs::read_dir(root.path().join("runs"))?.count(), 0);

    // A hung renderer command cannot consume an unbounded queue or hold the
    // profile after cancellation. Pending replies are never reused by a new run.
    let session = runtime
        .start(&profile, Mode::Headless, fixture.policy())
        .await?;
    let page = page(&session, &fixture.url()).await?;
    let before = snapshot(&session);
    let mut requests = tokio::task::JoinSet::new();
    for _ in 0..32 {
        let session = session.clone();
        let page = page.clone();
        requests.spawn(async move { session.evaluate(&page, "new Promise(()=>{})").await });
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let exit = session.close().await;
    assert!(exit.supervisor_reaped && !exit.graceful);
    let mut rejected = 0;
    while let Some(result) = requests.join_next().await {
        let error = result?.unwrap_err();
        if error.code == "browser_queue_full" {
            rejected += 1;
        } else {
            assert_eq!(error.code, "browser_closed");
        }
    }
    assert!(rejected >= 23);
    gone(&before).await?;
    let resumed = runtime
        .start(&profile, Mode::Headless, fixture.policy())
        .await?;
    let resumed_page = self::page(&resumed, &fixture.url()).await?;
    assert_eq!(
        resumed
            .evaluate(&resumed_page, "localStorage.getItem('owner')")
            .await?,
        "dsp-a"
    );
    // Dropping a caller while its request is in flight also retires the session.
    let request = {
        let session = resumed.clone();
        let page = resumed_page.clone();
        tokio::spawn(async move { session.evaluate(&page, "new Promise(()=>{})").await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    request.abort();
    let _ = request.await;
    let before = snapshot(&resumed);
    assert!(
        timeout(Duration::from_secs(5), resumed.wait_closed())
            .await?
            .supervisor_reaped
    );
    gone(&before).await?;

    // A deadline failure forces cleanup and leaves the persistent profile usable.
    let session = runtime
        .start(&profile, Mode::Headless, fixture.policy())
        .await?;
    let page = self::page(&session, &fixture.url()).await?;
    let started = Instant::now();
    let error = session
        .evaluate(&page, "new Promise(()=>{})")
        .await
        .unwrap_err();
    assert!(["browser_command_timeout", "browser_command_failed"].contains(&error.code.as_str()));
    assert!(started.elapsed() < Duration::from_secs(20));
    assert!(
        timeout(Duration::from_secs(5), session.wait_closed())
            .await?
            .supervisor_reaped
    );
    let failed = self::runtime(root.path(), Path::new("/usr/bin/true"))?;
    assert_eq!(
        failed
            .start(&profile, Mode::Headless, fixture.policy())
            .await
            .err()
            .unwrap()
            .code,
        "browser_start_failed"
    );
    let final_session = runtime
        .start(&profile, Mode::Headless, fixture.policy())
        .await?;
    assert!(final_session.close().await.graceful);
    assert_eq!(fs::read_dir(root.path().join("runs"))?.count(), 0);

    // Abandoning startup must keep the actor alive just long enough to reap its
    // child, then release both the profile lease and the capacity permit.
    let task = {
        let runtime = runtime.clone();
        let profile = profile.clone();
        let policy = fixture.policy();
        tokio::spawn(async move { runtime.start(&profile, Mode::Headless, policy).await })
    };
    timeout(Duration::from_secs(5), async {
        while fs::read_dir(root.path().join("runs")).unwrap().count() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await?;
    task.abort();
    let _ = task.await;
    timeout(Duration::from_secs(5), async {
        while fs::read_dir(root.path().join("runs")).unwrap().count() != 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await?;
    // Aborting startup drops its caller before the supervisor finishes cleanup.
    // Removing the run directory precedes releasing the profile/capacity lease;
    // wait for the actual public acquisition result rather than that file marker.
    let retry_until = Instant::now() + Duration::from_secs(5);
    let dropped = loop {
        match runtime
            .start(&profile, Mode::Headless, fixture.policy())
            .await
        {
            Ok(session) => break session,
            Err(error)
                if Instant::now() < retry_until
                    && ["browser_profile_busy", "browser_capacity_busy"]
                        .contains(&error.code.as_str()) =>
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => return Err(error.into()),
        }
    };
    let before = snapshot(&dropped);
    drop(dropped);
    gone(&before).await?;
    timeout(Duration::from_secs(5), async {
        while fs::read_dir(root.path().join("runs")).unwrap().count() != 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await?;
    println!(
        "BrowserOS worker: profiles, isolation, egress, scripts, queue, deadlines, cancellation and restart passed"
    );
    Ok(())
}
