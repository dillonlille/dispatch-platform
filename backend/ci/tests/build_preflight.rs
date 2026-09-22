//! Exercise the native CLI with real Git worktrees and subprocess boundaries.
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::{Command, Output},
};
fn checked(command: &mut Command) -> Output {
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}
fn git(root: &Path, args: &[&str]) {
    checked(Command::new("git").current_dir(root).args(args));
}
fn executable(path: &Path, source: &str) {
    fs::write(path, source).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
#[test]
fn native_build_shares_verified_copies_across_worktrees_and_rebuilds_changed_inputs() {
    let temp = tempfile::tempdir().unwrap();
    let one = temp.path().join("one");
    let two = temp.path().join("two");
    let bin = temp.path().join("bin");
    fs::create_dir_all(one.join("backend/src")).unwrap();
    fs::create_dir(&bin).unwrap();
    fs::write(
        one.join("Cargo.toml"),
        "[workspace]\nmembers = ['backend']\n",
    )
    .unwrap();
    fs::write(
        one.join("backend/Cargo.toml"),
        "[package]\nname = 'dispatch-backend'\n",
    )
    .unwrap();
    fs::write(one.join("backend/src/main.rs"), "first input").unwrap();
    git(&one, &["init", "-q"]);
    git(&one, &["add", "."]);
    git(
        &one,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-qm",
            "fixture",
        ],
    );
    git(
        &one,
        &["worktree", "add", "--detach", two.to_str().unwrap()],
    );
    executable(&bin.join("rustc"), "#!/bin/sh\necho pinned-rustc\n");
    executable(&bin.join("cc"), "#!/bin/sh\necho pinned-cc\n");
    executable(&bin.join("ld"), "#!/bin/sh\necho pinned-ld\n");
    executable(
        &bin.join("cargo"),
        "#!/bin/sh\nset -eu\nprintf x >> \"$BUILDS\"\nmkdir -p target/release\ncp backend/src/main.rs target/release/dispatch-backend\n",
    );
    let builds = temp.path().join("build-count");
    let run = |root: &Path| {
        checked(
            Command::new(env!("CARGO_BIN_EXE_dispatch-ci"))
                .args(["build", "--release", "--root", root.to_str().unwrap()])
                .env_clear()
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .env("CARGO_HOME", temp.path().join("cargo-home"))
                .env("BUILDS", &builds),
        )
    };
    run(&one);
    assert!(String::from_utf8_lossy(&run(&two).stdout).contains("Reused"));
    assert_eq!(fs::read(&builds).unwrap(), b"x");
    let target = two.join("target/release/dispatch-backend");
    fs::write(&target, "local corruption").unwrap();
    run(&two);
    assert_eq!(fs::read(&target).unwrap(), b"first input");
    fs::write(two.join("backend/src/main.rs"), "changed input").unwrap();
    run(&two);
    assert_eq!(fs::read(&target).unwrap(), b"changed input");
    assert_eq!(fs::read(&builds).unwrap(), b"xx");
}
#[test]
fn native_preflight_fetches_actual_base_and_refuses_dirty_or_stale_work() {
    let temp = tempfile::tempdir().unwrap();
    let remote = temp.path().join("remote");
    let checkout = temp.path().join("checkout");
    let bin = temp.path().join("bin");
    fs::create_dir(&remote).unwrap();
    fs::create_dir(&bin).unwrap();
    git(&remote, &["init", "-q", "-b", "dev"]);
    git(
        &remote,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-qm",
            "initial",
        ],
    );
    git(
        temp.path(),
        &[
            "clone",
            "-q",
            remote.to_str().unwrap(),
            checkout.to_str().unwrap(),
        ],
    );
    git(&checkout, &["checkout", "-qb", "feature/test"]);
    executable(&bin.join("gh"), "#!/bin/sh\nprintf '[]'\n");
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_dispatch-ci"))
            .args(["preflight", "--root", checkout.to_str().unwrap()])
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .output()
            .unwrap()
    };
    assert!(run().status.success());
    fs::write(checkout.join("uncommitted"), "change").unwrap();
    let dirty = run();
    assert!(!dirty.status.success());
    assert!(String::from_utf8_lossy(&dirty.stderr).contains("Commit the completed changes"));
    fs::remove_file(checkout.join("uncommitted")).unwrap();
    git(
        &remote,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-qm",
            "advance",
        ],
    );
    let stale = run();
    assert!(!stale.status.success());
    assert!(String::from_utf8_lossy(&stale.stderr).contains("origin/dev has advanced"));
    git(&checkout, &["merge", "--ff-only", "origin/dev"]);
    assert!(run().status.success());
    executable(&bin.join("gh"), "#!/bin/sh\nexit 1\n");
    assert!(!run().status.success(), "API failure cannot allow a push");
}
