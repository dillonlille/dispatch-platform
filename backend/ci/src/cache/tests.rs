use super::*;
use std::{
    cell::Cell,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    time::{Duration, UNIX_EPOCH},
};
struct Fixture {
    temp: tempfile::TempDir,
    root: PathBuf,
    env: Environment,
    builds: Cell<usize>,
    change_during_build: Cell<bool>,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        fs::create_dir_all(root.join("backend/src")).unwrap();
        fs::create_dir_all(root.join("tooling")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(
            root.join("Cargo.toml"),
            "[workspace]\nmembers = [\"backend\"]\n",
        )
        .unwrap();
        fs::write(
            root.join("backend/Cargo.toml"),
            "[package]\nname = \"fixture\"\n",
        )
        .unwrap();
        fs::write(root.join("backend/src/main.rs"), "one").unwrap();
        let env = [(
            "CARGO_HOME".into(),
            temp.path().join("cargo-home").to_str().unwrap().into(),
        )]
        .into_iter()
        .collect();
        Self {
            temp,
            root,
            env,
            builds: Cell::new(0),
            change_during_build: Cell::new(false),
        }
    }
    fn build(&self) {
        build_with_limit(&self.root, false, &self.env, self, 2).unwrap();
    }
    fn source(&self, text: &str) {
        fs::write(self.root.join("backend/src/main.rs"), text).unwrap();
    }
    fn store(&self) -> PathBuf {
        self.root.join(".git/dispatch-rust-builds")
    }
}
impl Runner for Fixture {
    fn command(&self, args: &[&str], cwd: Option<&Path>, _timeout: u64) -> Result<Vec<u8>> {
        assert_eq!(cwd, Some(self.root.as_path()));
        match args[0] {
            "rustc" | "cc" => Ok(b"pinned compiler".to_vec()),
            "git" => Ok(self.root.join(".git").to_str().unwrap().as_bytes().to_vec()),
            "cargo" => {
                self.builds.set(self.builds.get() + 1);
                let target = self
                    .root
                    .join("target")
                    .join(if args.contains(&"--release") {
                        "release"
                    } else {
                        "debug"
                    });
                fs::create_dir_all(&target)?;
                fs::write(
                    target.join("dispatch-backend"),
                    fs::read(self.root.join("backend/src/main.rs"))?,
                )?;
                if self.change_during_build.get() {
                    self.source("changed mid-build");
                }
                Ok(vec![])
            }
            _ => panic!("Unexpected command"),
        }
    }
}
#[test]
fn custom_build_inputs_and_untracked_external_sources_disable_reuse() {
    let f = Fixture::new();
    assert!(eligible(&f.root, &f.env, false).unwrap());
    for (key, value) in [
        ("CI", "true"),
        ("DISPATCH_DISABLE_RUST_CACHE", "1"),
        ("CARGO_TARGET_DIR", "/custom"),
        ("RUSTC_WRAPPER", "/wrapper"),
        ("CARGO_SOURCE_LOCAL_DIRECTORY", "/outside"),
        ("CARGO_BUILD_TARGET", "other"),
    ] {
        let mut env = f.env.clone();
        env.insert(key.into(), value.into());
        assert!(!eligible(&f.root, &env, false).unwrap(), "{key}");
    }
    for name in ["backend/build.rs", "backend/linked"] {
        let path = f.root.join(name);
        if name.ends_with("linked") {
            symlink(f.temp.path(), &path).unwrap();
        } else {
            fs::write(&path, "build").unwrap();
        }
        assert!(!eligible(&f.root, &f.env, false).unwrap());
        fs::remove_file(path).unwrap();
    }
    fs::create_dir_all(f.root.join("backend/host")).unwrap();
    fs::create_dir_all(f.root.join("backend/ci")).unwrap();
    fs::write(
        f.root.join("Cargo.toml"),
        "[workspace]\nmembers = [\"backend\", \"backend/host\", \"backend/ci\"]\n",
    )
    .unwrap();
    fs::write(
        f.root.join("backend/Cargo.toml"),
        "[dependencies]\nhost = { path = \"host\" }\n",
    )
    .unwrap();
    let manifest = f.root.join("backend/host/Cargo.toml");
    fs::write(&manifest, "[dependencies]\nci = { path = \"../ci\" }\n").unwrap();
    assert!(eligible(&f.root, &f.env, false).unwrap());
    for text in [
        "[dependencies]\nexternal = { path = \"../../../outside\" }\n",
        "[package]\nbuild = \"elsewhere.rs\"\n",
    ] {
        fs::write(&manifest, text).unwrap();
        assert!(!eligible(&f.root, &f.env, false).unwrap());
    }
    fs::write(&manifest, "[package]\nbuild = false\n").unwrap();
    assert!(eligible(&f.root, &f.env, false).unwrap());
    let config = f.temp.path().join(".cargo/config.toml");
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    fs::write(config, "[build]\n").unwrap();
    assert!(!eligible(&f.root, &f.env, false).unwrap());
}
#[test]
fn every_rust_and_embedded_launcher_input_is_fingerprinted_but_dashboard_is_not() {
    let f = Fixture::new();
    let g = Fixture::new();
    let key = |f: &Fixture| {
        fingerprint(
            &f.root,
            "release",
            "compiler",
            &Environment::from([(
                "CARGO_HOME".into(),
                "/nonexistent-dispatch-test-home".into(),
            )]),
        )
        .unwrap()
    };
    assert_eq!(key(&f), key(&g));
    let original = key(&f);
    fs::create_dir(f.root.join("dashboard")).unwrap();
    fs::write(f.root.join("dashboard/app.tsx"), "ui").unwrap();
    assert_eq!(original, key(&f));
    for name in [
        "Cargo.lock",
        "rust-toolchain.toml",
        "backend/src/provider.js",
        "backend/schema.sql",
        "backend/host/src/management.rs",
        "backend/ci/src/cache.rs",
        "tooling/cargo-build.py",
        "tooling/ci_tool.py",
        "tooling/runtime_artifact.py",
        "tooling/update-dev.py",
        "tooling/update-production.py",
    ] {
        let path = f.root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "new input").unwrap();
        assert_ne!(original, key(&f), "{name}");
        fs::remove_file(path).unwrap();
    }
    assert_ne!(
        fingerprint(&f.root, "release", "compiler", &f.env).unwrap(),
        fingerprint(&f.root, "debug", "compiler", &f.env).unwrap()
    );
    let mut flags = f.env.clone();
    flags.insert("RUSTFLAGS".into(), "custom".into());
    assert_ne!(
        fingerprint(&f.root, "release", "compiler", &f.env).unwrap(),
        fingerprint(&f.root, "release", "compiler", &flags).unwrap()
    );
    assert_ne!(
        fingerprint(&f.root, "release", "compiler", &f.env).unwrap(),
        fingerprint(&f.root, "release", "new compiler", &f.env).unwrap()
    );
}
#[test]
fn cache_reuses_intact_binaries_refreshes_recency_and_rebuilds_corruption() {
    let f = Fixture::new();
    f.build();
    f.source("two");
    f.build();
    f.source("one");
    f.build();
    assert_eq!(f.builds.get(), 2);
    f.source("three");
    f.build();
    f.source("one");
    f.build();
    assert_eq!(f.builds.get(), 3);
    f.source("two");
    f.build();
    assert_eq!(f.builds.get(), 4);
    let entries: Vec<_> = fs::read_dir(f.store())
        .unwrap()
        .map(|p| p.unwrap().path())
        .filter(|p| p.is_dir())
        .collect();
    assert_eq!(entries.len(), 2);
    for entry in entries {
        assert!(store::cached_binary(&entry).is_some());
        fs::write(entry.join("dispatch-backend"), "corrupt").unwrap();
    }
    f.build();
    assert_eq!(f.builds.get(), 5);
    assert_eq!(
        fs::read(f.root.join("target/debug/dispatch-backend")).unwrap(),
        b"two"
    );
    assert_eq!(
        fs::metadata(f.root.join("target/debug/dispatch-backend"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}
#[test]
fn changing_inputs_during_build_cannot_publish_cache_entry() {
    let f = Fixture::new();
    f.change_during_build.set(true);
    assert!(build(&f.root, false, &f.env, &f).is_err());
    assert!(
        !fs::read_dir(f.store())
            .unwrap()
            .any(|p| p.unwrap().path().is_dir())
    );
}
#[test]
fn cache_pruning_keeps_busy_entries_and_lock_identity_survives_deletion() {
    let f = Fixture::new();
    let cache = f.store();
    store::directory(&cache).unwrap();
    let keys: Vec<_> = (1..=5).map(|n| format!("{n:064x}")).collect();
    for (index, key) in keys.iter().enumerate() {
        let entry = cache.join(key);
        fs::create_dir(&entry).unwrap();
        fs::File::open(entry)
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_modified(UNIX_EPOCH + Duration::from_secs(1000 - index as u64)),
            )
            .unwrap();
    }
    let busy = store::Lock::acquire(&cache, &keys[3], true)
        .unwrap()
        .unwrap();
    assert!(
        store::Lock::acquire(&cache, &keys[3], false)
            .unwrap()
            .is_none()
    );
    store::prune(&cache, 3, &keys[4]).unwrap();
    assert!(cache.join(&keys[3]).exists());
    assert!(!cache.join(&keys[2]).exists());
    drop(busy);
    store::prune(&cache, 3, &keys[4]).unwrap();
    assert!(!cache.join(&keys[3]).exists());
    let stale = store::Lock::acquire(&cache, &keys[0], true)
        .unwrap()
        .unwrap();
    fs::remove_file(cache.join(format!("{}.lock", keys[0]))).unwrap();
    assert!(
        store::Lock::acquire(&cache, &keys[0], false)
            .unwrap()
            .is_some()
    );
    drop(stale);
    store::prune(&cache, 0, &keys[4]).unwrap();
    assert!(cache.join(&keys[4]).exists());
    assert_eq!(
        fs::read_dir(cache)
            .unwrap()
            .filter(|p| p.as_ref().unwrap().path().is_dir())
            .count(),
        1
    );
}
#[test]
fn ci_cache_needs_explicit_location_and_current_receipt_key() {
    let mut f = Fixture::new();
    f.env.insert("CI".into(), "true".into());
    assert!(!eligible(&f.root, &f.env, false).unwrap());
    assert!(eligible(&f.root, &f.env, true).unwrap());
    assert!(!ci_enabled(&f.root, &f.env));
    f.env.insert(
        "DISPATCH_CI_RUST_CACHE".into(),
        f.root.join(".ci-rust-cache").to_str().unwrap().into(),
    );
    assert!(ci_enabled(&f.root, &f.env));
    build(&f.root, true, &f.env, &f).unwrap();
    build(&f.root, true, &f.env, &f).unwrap();
    assert_eq!(f.builds.get(), 1);
    f.env.insert("DISPATCH_CI_RUST_KEY".into(), "wrong".into());
    assert!(build(&f.root, true, &f.env, &f).is_err());
    assert_eq!(f.builds.get(), 1);
}
#[test]
fn promoted_binary_can_only_seed_its_original_eligible_compiler_key() {
    let f = Fixture::new();
    let source = f.temp.path().join("verified");
    fs::write(&source, "verified backend").unwrap();
    let key = key(&f.root, "release", &f.env, &f).unwrap();
    seed(&f.root, &source, &"f".repeat(64), &f.env, &f).unwrap();
    assert!(!f.root.join(".ci-rust-cache").exists());
    let mut ineligible = f.env.clone();
    ineligible.insert("DISPATCH_DISABLE_RUST_CACHE".into(), "1".into());
    seed(&f.root, &source, &key, &ineligible, &f).unwrap();
    assert!(!f.root.join(".ci-rust-cache").exists());
    seed(&f.root, &source, &key, &f.env, &f).unwrap();
    let binary = store::cached_binary(&f.root.join(".ci-rust-cache").join(key)).unwrap();
    assert_eq!(fs::read(binary).unwrap(), b"verified backend");
}
