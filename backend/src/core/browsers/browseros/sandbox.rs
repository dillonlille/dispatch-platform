use super::*;
pub(super) fn trusted(path: &Path, root_owned: bool) -> Result<PathBuf> {
    let path = fs::canonicalize(path)?;
    let stat = fs::metadata(&path)?;
    ensure(
        stat.is_file()
            && stat.mode() & 0o111 != 0
            && stat.mode() & 0o022 == 0
            && (stat.uid() == 0 || (!root_owned && stat.uid() == unsafe { libc::geteuid() })),
        "trusted_browser_executable_required",
        503,
    )?;
    if root_owned {
        for parent in path.ancestors().skip(1) {
            let stat = fs::metadata(parent)?;
            ensure(
                stat.is_dir() && stat.uid() == 0 && stat.mode() & 0o022 == 0,
                "trusted_browser_executable_required",
                503,
            )?;
        }
    }
    Ok(path)
}
pub(super) fn launch(runtime: &Runtime, run: &Path, profile: &Path, mode: Mode) -> Result<Child> {
    let mut command = Command::new(&runtime.sandbox);
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
        .arg(runtime.browser.parent().unwrap())
        .arg("/browser")
        .arg("--ro-bind")
        .arg(&runtime.executable)
        .arg("/runtime/dispatch-backend")
        .arg("--bind")
        .arg(profile)
        .arg("/profile")
        .arg("--ro-bind")
        .arg(run.join("egress.sock"))
        .arg("/run/dispatch/egress.sock")
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
    for namespace in ["pid", "net", "mnt", "ipc", "uts", "user"] {
        command
            .arg("--setenv")
            .arg(format!("DISPATCH_HOST_{namespace}"))
            .arg(fs::read_link(format!("/proc/self/ns/{namespace}"))?);
    }
    command
        .args([
            "--chdir",
            "/profile",
            "/runtime/dispatch-backend",
            "browseros-worker",
            mode.argument(),
        ])
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    Ok(command.spawn()?)
}
