use serde_json::json;
use std::{fs, process::Command};

#[test]
fn native_entry_point_appends_plan_outputs_and_fails_closed_at_the_gate() {
    let temp = tempfile::tempdir().unwrap();
    let event = temp.path().join("event.json");
    let output = temp.path().join("output");
    let summary = temp.path().join("summary");
    fs::write(&event, "{}").unwrap();
    fs::write(&output, "previous=value\n").unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_dispatch-ci"))
        .args(["plan", "--root", temp.path().to_str().unwrap()])
        .env("GITHUB_EVENT_PATH", &event)
        .env("GITHUB_EVENT_NAME", "workflow_dispatch")
        .env("GITHUB_REF", "refs/heads/main")
        .env("GITHUB_OUTPUT", &output)
        .env("GITHUB_STEP_SUMMARY", &summary)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(
        fs::read_to_string(&output).unwrap(),
        "previous=value\nmode=full\n"
    );
    assert!(fs::read_to_string(&summary).unwrap().contains("**full**"));
    let needs = json!({"plan":{"result":"success","outputs":{"mode":"full"}},"build":{"result":"success"},"browser":{"result":"success"},"benchmark":{"result":"success"},"core":{"result":"success"},"collectors":{"result":"success"},"rust-advisories":{"result":"success"}});
    for valid in [true, false] {
        let mut value = needs.clone();
        if !valid {
            value["collectors"]["result"] = "failure".into();
        }
        let result = Command::new(env!("CARGO_BIN_EXE_dispatch-ci"))
            .arg("gate")
            .env("CI_NEEDS", value.to_string())
            .output()
            .unwrap();
        assert_eq!(result.status.success(), valid);
        if !valid {
            assert!(String::from_utf8_lossy(&result.stderr).contains("collectors"));
        }
    }
}
