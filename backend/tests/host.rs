use dispatch_backend::core::{browsers::sandbox, config::Config};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    time::Duration,
};
#[tokio::test]
async fn native_host_has_nested_sandboxes_and_real_os_input() {
    if std::env::var("DISPATCH_TEST_HOST").as_deref() != Ok("1") {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let bundle = root.path().join("services/runtime");
    fs::create_dir_all(&bundle).unwrap();
    // cargo tests run in the crate directory; host verification always uses .build.
    let built = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".build");
    symlink(built.join("node_modules"), root.path().join("node_modules")).unwrap();
    assert!(
        std::process::Command::new("cp")
            .args(["-R"])
            .arg(built.join("services/runtime/provider"))
            .arg(bundle.join("provider"))
            .status()
            .unwrap()
            .success()
    );
    fs::create_dir(bundle.join("node_modules")).unwrap();
    fs::write(bundle.join("package.json"), r#"{"type":"module"}"#).unwrap();
    fs::write(
        bundle.join("auth-worker.js"),
        include_str!("fixtures/preflight.js"),
    )
    .unwrap();
    let mut config = Config::load().unwrap();
    config.bundle = bundle;
    config.fixture = false;
    let run = root.path().join("run");
    let profile = root.path().join("profile");
    fs::create_dir(&run).unwrap();
    fs::create_dir(&profile).unwrap();
    for directory in [&run, &profile] {
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let mut child = sandbox::command(&config, &run, Some(&profile))
        .unwrap()
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    drop(child.stdin.take());
    let result = tokio::time::timeout(Duration::from_secs(30), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    let output = String::from_utf8_lossy(&result.stdout);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    for expected in [
        "Layer 1 Sandbox",
        "Namespace",
        "PID namespaces",
        "Network namespaces",
        "Seccomp-BPF sandbox",
        "Native OS input verified",
    ] {
        assert!(output.contains(expected), "{output}");
    }
    println!("{output}");
}
