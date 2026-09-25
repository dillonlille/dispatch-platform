use super::*;
use serde_json::json;
use std::path::PathBuf;

#[test]
fn both_repository_names_are_this_repository_and_nothing_else_is() {
    for name in REPOSITORIES {
        assert!(ours(&json!(name)), "{name}");
        assert_eq!(
            web_path(&format!("https://github.com/{name}/releases/latest")),
            Some("releases/latest")
        );
    }
    for other in [
        json!("other/dispatch-platform"),
        json!("dispatch-systems/dispatch-platform-fork"),
        json!("dispatch-systems"),
        json!(""),
        json!(null),
        json!(["dispatch-systems/dispatch-platform"]),
    ] {
        assert!(!ours(&other), "{other}");
    }
    for url in [
        "https://github.com/dispatch-systems/dispatch-platform-fork/releases/latest",
        "https://github.com/dispatch-systems/dispatch-platform",
        "http://github.com/dispatch-systems/dispatch-platform/releases/latest",
        "https://github.com.evil/dispatch-systems/dispatch-platform/releases/latest",
    ] {
        assert_eq!(web_path(url), None, "{url}");
    }
}

#[test]
fn hex_accepts_only_lowercase_digits_of_the_exact_length() {
    assert!(hex(&"a".repeat(40), 40));
    assert!(hex("0123456789abcdef", 16));
    assert!(!hex(&"a".repeat(39), 40));
    assert!(!hex(&"A".repeat(40), 40));
    assert!(!hex("0123456789abcdeg", 16));
    assert!(hex("", 0));
}

#[test]
fn native_runner_bounds_output_timeout_and_honors_cwd() {
    let temp = tempfile::tempdir().unwrap();
    let bytes = Native.command(&["pwd"], Some(temp.path()), 1).unwrap();
    assert_eq!(
        PathBuf::from(String::from_utf8(bytes).unwrap().trim()),
        temp.path()
    );
    assert!(Native.command(&["sh", "-c", "sleep 10"], None, 0).is_err());
    assert!(
        Native
            .command(&["sh", "-c", "printf expected >&2; exit 1"], None, 1)
            .unwrap_err()
            .to_string()
            .contains("expected")
    );
    assert!(
        Native
            .command(&["sh", "-c", "head -c 16777217 /dev/zero"], None, 10)
            .is_err()
    );
}
