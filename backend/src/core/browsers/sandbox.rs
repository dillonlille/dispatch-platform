use crate::core::{Result, config::Config, ensure};
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::{Child, Command};
fn trusted(file: &Path, ancestors: bool) -> Result<PathBuf> {
    let file = fs::canonicalize(file)?;
    let stat = fs::metadata(&file)?;
    ensure(
        stat.is_file() && stat.uid() == 0 && stat.mode() & 0o022 == 0 && stat.mode() & 0o111 != 0,
        "trusted_browser_executable_required",
        503,
    )?;
    if ancestors {
        for parent in file.ancestors().skip(1) {
            let s = fs::metadata(parent)?;
            ensure(
                s.is_dir() && s.uid() == 0 && s.mode() & 0o022 == 0,
                "trusted_browser_executable_required",
                503,
            )?;
        }
    }
    Ok(file)
}
pub fn launch(config: &Config, run: &Path, profile: Option<&Path>) -> Result<Child> {
    Ok(command(config, run, profile)?.spawn()?)
}
pub fn command(config: &Config, run: &Path, profile: Option<&Path>) -> Result<Command> {
    let executable = trusted(&config.sandbox, false)?;
    let node = fs::canonicalize(&config.node)?;
    let stat = fs::metadata(&node)?;
    ensure(
        stat.is_file()
            && stat.mode() & 0o022 == 0
            && stat.mode() & 0o111 != 0
            && (stat.uid() == 0 || stat.uid() == unsafe { libc::geteuid() }),
        "trusted_worker_node_required",
        503,
    )?;
    let mut args: Vec<String> = [
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
        "--ro-bind",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    args.extend([node.to_string_lossy().into_owned(), "/runtime/node".into()]);
    if Path::new("/usr/lib64").exists() {
        args.extend(["--symlink", "usr/lib64", "/lib64"].map(str::to_owned));
    }
    for file in [
        "/etc/fonts",
        "/etc/ssl",
        "/etc/passwd",
        "/etc/group",
        "/etc/nsswitch.conf",
    ] {
        if Path::new(file).exists() {
            args.extend(["--ro-bind", file, file].map(str::to_owned));
        }
    }
    let bundle = fs::canonicalize(&config.bundle)?;
    ensure(
        bundle.join("auth-worker.js").is_file(),
        "browser_runtime_not_built",
        503,
    )?;
    args.extend([
        "--ro-bind".into(),
        bundle.to_string_lossy().into_owned(),
        "/app".into(),
        "--ro-bind".into(),
        bundle
            .join("../../node_modules")
            .to_string_lossy()
            .into_owned(),
        "/app/node_modules".into(),
    ]);
    let mut browser = None;
    if let Some(profile) = profile {
        let path = if config.fixture {
            fs::canonicalize(&config.browser)?
        } else {
            trusted(&config.browser, true)?
        };
        if !config.fixture {
            for path in ["/usr/bin/Xvfb", "/usr/bin/python3", "/usr/bin/setpriv"] {
                trusted(Path::new(path), true)?;
            }
        }
        args.extend([
            "--ro-bind".into(),
            path.parent().unwrap().to_string_lossy().into_owned(),
            path.parent().unwrap().to_string_lossy().into_owned(),
            "--bind".into(),
            profile.to_string_lossy().into_owned(),
            "/profile".into(),
            "--bind".into(),
            run.to_string_lossy().into_owned(),
            "/run/dispatch".into(),
        ]);
        browser = Some(path);
    } else {
        args.extend([
            "--ro-bind".into(),
            run.join("cdp.sock").to_string_lossy().into_owned(),
            "/run/dispatch/cdp.sock".into(),
        ]);
    }
    args.extend(
        [
            "--clearenv",
            "--setenv",
            "PATH",
            "/usr/bin:/bin",
            "--setenv",
            "LANG",
            "C.UTF-8",
            "--setenv",
            "XDG_CONFIG_HOME",
            "/tmp/config",
            "--setenv",
            "XDG_CACHE_HOME",
            "/tmp/cache",
        ]
        .map(str::to_owned),
    );
    if !config.fixture && profile.is_some() {
        args.extend(["--setenv", "DISPATCH_ISOLATED_BROWSER", "1"].map(str::to_owned));
    }
    args.extend(
        [
            "--chdir",
            "/app",
            "/runtime/node",
            "--no-warnings",
            "--max-old-space-size=256",
        ]
        .map(str::to_owned),
    );
    args.push(
        if profile.is_some() {
            "/app/auth-worker.js"
        } else {
            "/app/collection-worker.js"
        }
        .into(),
    );
    if let Some(path) = browser {
        args.push(path.to_string_lossy().into_owned());
    }
    let mut command = Command::new(executable);
    command
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    Ok(command)
}
