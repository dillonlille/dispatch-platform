//! The browser worker runs with its standard error closed, so a refusal to start has to
//! reach its supervisor as a frame on the pipe. Outside the sandbox it refuses at once.
use std::process::Command;

#[test]
fn a_worker_that_cannot_start_reports_its_own_reason_before_exiting() {
    let output = Command::new(env!("CARGO_BIN_EXE_dispatch-backend"))
        .args(["browseros-worker", "headless"])
        .env("HOME", "/nonexistent")
        .env_remove("DISPATCH_STATE_ROOT")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let reported: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reported["error"], "browser_isolation_required");
    assert_eq!(reported["ready"], serde_json::Value::Null);
}

#[test]
fn an_unknown_mode_is_refused_the_same_way() {
    let output = Command::new(env!("CARGO_BIN_EXE_dispatch-backend"))
        .args(["browseros-worker", "windowless"])
        .env("HOME", "/nonexistent")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let reported: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reported["error"], "invalid_browser_mode");
}
