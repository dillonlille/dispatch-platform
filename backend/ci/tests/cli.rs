use std::process::Command;

#[test]
fn native_entry_point_names_its_commands_and_refuses_the_rest() {
    let run = |args: &[&str]| {
        let result = Command::new(env!("CARGO_BIN_EXE_dispatch-ci"))
            .args(args)
            .output()
            .unwrap();
        (
            result.status.success(),
            String::from_utf8_lossy(&result.stderr).into_owned(),
        )
    };
    let (ok, error) = run(&[]);
    assert!(!ok);
    assert!(error.contains("Choose build, preflight or ship"), "{error}");
    // The planner, receipts and gate are gone: every suite runs in every queue run.
    for gone in ["plan", "receipt", "gate"] {
        let (ok, error) = run(&[gone]);
        assert!(!ok, "{gone}");
        assert!(error.contains("Unknown CI command"), "{error}");
    }
    let (ok, error) = run(&["ship"]);
    assert!(!ok);
    assert!(
        error.contains("Usage: npm run pr:ship -- <PR number>"),
        "{error}"
    );
    let (ok, error) = run(&["build", "--scope", "full"]);
    assert!(!ok);
    assert!(error.contains("Unknown CI option"), "{error}");
}
