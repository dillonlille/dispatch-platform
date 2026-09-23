use super::*;
use crate::io::{Native, Response};
use std::cell::Cell;
use std::os::unix::fs::symlink;
const COMMIT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
#[derive(Default)]
struct Fake {
    bootstraps: Cell<usize>,
    fail: Cell<bool>,
    bad_manager: Cell<bool>,
    dirty: Cell<bool>,
    stale: Cell<bool>,
    wrong_origin: Cell<bool>,
    tracked_private: Cell<bool>,
}
impl System for Fake {
    fn command(
        &self,
        args: &[&str],
        cwd: Option<&Path>,
        timeout: u64,
        output: Option<&Path>,
    ) -> Result<Vec<u8>> {
        if args[0] == "git" {
            return Ok(match args[1] {
                "branch" => b"main".to_vec(),
                "status" => {
                    if self.dirty.get() {
                        b"modified".to_vec()
                    } else {
                        vec![]
                    }
                }
                "fetch" => vec![],
                "remote" => {
                    if self.wrong_origin.get() {
                        b"wrong repository".to_vec()
                    } else {
                        format!("https://github.com/{}.git", crate::REPOSITORY).into_bytes()
                    }
                }
                "ls-tree" => {
                    if self.tracked_private.get() {
                        b"config/private".to_vec()
                    } else {
                        vec![]
                    }
                }
                "rev-parse" => {
                    if self.stale.get() && args[2] == "origin/main" {
                        "b".repeat(40).into_bytes()
                    } else {
                        COMMIT.as_bytes().to_vec()
                    }
                }
                _ => panic!("Unexpected Git"),
            });
        }
        if args.get(1) == Some(&"host") && args.get(2) == Some(&"capabilities") {
            require(!self.bad_manager.get(), "Staged manager failed")?;
            return Ok(br#"{"hostManagement":1}"#.to_vec());
        }
        Native.command(args, cwd, timeout, output)
    }
    fn request(&self, _url: &str, _head: bool, _follow: bool, _timeout: u64) -> Result<Response> {
        panic!("Setup must not contact services")
    }
    fn bootstrap(
        &self,
        args: &[&str],
        cwd: &Path,
        env: &BTreeMap<String, String>,
        input: &[u8],
    ) -> Result<()> {
        self.bootstraps.set(self.bootstraps.get() + 1);
        assert_eq!(args[1], "bootstrap");
        assert_eq!(args[2], "owner@example.test");
        assert!(cwd.join("release.json").is_file());
        let password = std::str::from_utf8(input).unwrap().trim();
        assert!(artifact::hex(password, 60));
        assert!(
            !env.contains_key("MAIL_TOKEN")
                && !env.contains_key("GH_TOKEN")
                && !env.contains_key("HOME")
        );
        let root = Path::new(&env["DISPATCH_STATE_ROOT"]);
        assert!(
            root.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with(".setup-")
        );
        assert_eq!(
            io::read_json(&root.join("config/initial-owner.json"))?["password"],
            password
        );
        fs::write(
            root.join("data/platform/accounts.sqlite"),
            b"fresh owner database",
        )?;
        fs::set_permissions(
            root.join("data/platform/accounts.sqlite"),
            fs::Permissions::from_mode(0o600),
        )?;
        require(!self.fail.get(), "Interrupted bootstrap")
    }
}
struct Fixture {
    temp: tempfile::TempDir,
    options: Options,
    system: Fake,
}
impl Fixture {
    fn new(production: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(if production { "public" } else { "dev" });
        io::private_directory(&root).unwrap();
        let source = if production {
            temp.path().join("source")
        } else {
            root.join(".build")
        };
        for name in ["dashboard", "tooling", "services/rust"] {
            io::private_directory(&source.join(name)).unwrap();
        }
        fs::write(source.join("dashboard/index.html"), "dashboard").unwrap();
        fs::write(
            source.join("services/rust/dispatch-backend"),
            "#!/bin/sh\necho '{\"hostManagement\":1}'\n",
        )
        .unwrap();
        fs::write(
            source.join("tooling/build-info.json"),
            json!({"commit":COMMIT,"hostManagement":1}).to_string(),
        )
        .unwrap();
        artifact::write_manifest(&source, "1.0.0").unwrap();
        let archive = if production {
            let archive = temp.path().join("release.tar.gz");
            let file = fs::File::create(&archive).unwrap();
            let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
                file,
                flate2::Compression::default(),
            ));
            tar.append_dir_all(".", &source).unwrap();
            tar.into_inner().unwrap().finish().unwrap();
            Some(archive)
        } else {
            fs::create_dir(root.join(".git")).unwrap();
            None
        };
        let options = Options {
            root,
            production,
            origin: "https://dispatch.example.test".into(),
            email: "owner@example.test".into(),
            first: "First Name".into(),
            last: "Last Name".into(),
            provider: if production { "native" } else { "fixture" }.into(),
            sandbox: production.then(|| Path::new("/bin/true").canonicalize().unwrap()),
            archive,
            commit: production.then(|| COMMIT.into()),
            version: production.then(|| "1.0.0".into()),
        };
        Self {
            temp,
            options,
            system: Fake::default(),
        }
    }
    fn stage(&self) -> transaction::Journal {
        io::private_directory(&self.options.root.join(".runtime")).unwrap();
        prepare(&self.options, &self.system).unwrap()
    }
    fn ready(&self) {
        let root = &self.options.root;
        assert_eq!(
            fs::read(root.join("data/platform/accounts.sqlite")).unwrap(),
            b"fresh owner database"
        );
        let env = fs::read_to_string(root.join("config/platform.env")).unwrap();
        assert!(env.contains(&format!(
            "DISPATCH_STATE_ROOT={}\n",
            serde_json::to_string(root.to_str().unwrap()).unwrap()
        )));
        assert!(!env.contains(".setup-"));
        let owner = root.join("config/initial-owner.json");
        assert_eq!(
            owner.metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
        let manager = root.join(if self.options.production {
            "management"
        } else {
            ".runtime/management"
        });
        assert!(manager.join("dispatch-host").is_file());
        assert!(manager.join("runtime_artifact.py").is_file());
        assert!(
            manager
                .join(format!("update-{}.py", self.options.environment().name()))
                .is_file()
        );
        assert_eq!(
            manager
                .join("dispatch-host")
                .metadata()
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert!(!root.join(".runtime/setup.json").exists());
    }
}
#[test]
fn fresh_dev_and_production_setup_use_separate_private_state_and_complete_manager() {
    for production in [false, true] {
        let f = Fixture::new(production);
        initialize(&f.options, &f.system).unwrap();
        f.ready();
        assert_eq!(f.system.bootstraps.get(), 1);
        assert!(initialize(&f.options, &f.system).is_err());
        assert_eq!(f.system.bootstraps.get(), 1);
    }
}
#[test]
fn invalid_origin_owner_sandbox_and_existing_state_cannot_bootstrap() {
    for problem in [
        "origin",
        "origin_path",
        "email",
        "name",
        "sandbox",
        "state",
        "config",
        "symlink",
        "version",
        "source",
    ] {
        let mut f = Fixture::new(true);
        match problem {
            "origin" => f.options.origin = "http://dispatch.example.test".into(),
            "origin_path" => f.options.origin = "https://dispatch.example.test/path".into(),
            "email" => f.options.email = "invalid".into(),
            "name" => f.options.first = "injected\nKEY=value".into(),
            "sandbox" => {
                let path = f.temp.path().join("sandbox");
                fs::write(&path, "untrusted").unwrap();
                f.options.sandbox = Some(path);
            }
            "state" => {
                io::private_directory(&f.options.root.join("data/platform")).unwrap();
                fs::write(
                    f.options.root.join("data/platform/accounts.sqlite"),
                    "preserve",
                )
                .unwrap();
            }
            "config" => {
                io::private_directory(&f.options.root.join("config")).unwrap();
                fs::write(f.options.root.join("config/platform.env"), "preserve").unwrap();
            }
            "symlink" => {
                symlink(f.temp.path(), f.options.root.join("data")).unwrap();
            }
            "version" => f.options.version = Some("2.0.0".into()),
            "source" => f.options.commit = Some("b".repeat(40)),
            _ => unreachable!(),
        }
        assert!(initialize(&f.options, &f.system).is_err(), "{problem}");
        assert_eq!(f.system.bootstraps.get(), 0, "{problem}");
        if problem == "state" {
            assert_eq!(
                fs::read_to_string(f.options.root.join("data/platform/accounts.sqlite")).unwrap(),
                "preserve"
            );
        }
    }
}
#[test]
fn dev_setup_requires_clean_current_source_and_verified_runtime() {
    for problem in ["dirty", "stale", "tampered", "manager", "origin", "private"] {
        let f = Fixture::new(false);
        match problem {
            "dirty" => f.system.dirty.set(true),
            "origin" => f.system.wrong_origin.set(true),
            "private" => f.system.tracked_private.set(true),
            "stale" => f.system.stale.set(true),
            "tampered" => fs::write(
                f.options.root.join(".build/dashboard/index.html"),
                "tampered",
            )
            .unwrap(),
            "manager" => f.system.bad_manager.set(true),
            _ => unreachable!(),
        };
        assert!(initialize(&f.options, &f.system).is_err());
        assert_eq!(f.system.bootstraps.get(), 0);
        assert!(!f.options.root.join("config").exists());
    }
}
#[test]
fn interrupted_bootstrap_restarts_only_its_private_staging_directory() {
    let f = Fixture::new(true);
    f.system.fail.set(true);
    assert!(initialize(&f.options, &f.system).is_err());
    assert!(!f.options.root.join("config").exists());
    assert!(!f.options.root.join("data").exists());
    assert!(!f.options.root.join("live").exists());
    f.system.fail.set(false);
    initialize(&f.options, &f.system).unwrap();
    f.ready();
    assert_eq!(f.system.bootstraps.get(), 2);
}
#[test]
fn every_publish_interruption_resumes_without_recreating_accounts() {
    for production in [false, true] {
        for count in 0..=if production { 5 } else { 4 } {
            let f = Fixture::new(production);
            let journal = f.stage();
            let staging = f.options.root.join(".runtime").join(&journal.staging);
            for (source, target) in journal.placements().into_iter().take(count) {
                fs::rename(staging.join(source), f.options.root.join(target)).unwrap();
            }
            if !staging.join("config").exists() {
                fs::write(
                    f.options.root.join("data/platform/accounts.sqlite"),
                    b"fresh owner database",
                )
                .unwrap();
            }
            initialize(&f.options, &f.system).unwrap();
            f.ready();
            assert_eq!(f.system.bootstraps.get(), 1);
        }
    }
}
#[test]
fn prepared_state_tampering_conflicting_destinations_and_changed_arguments_fail_closed() {
    for problem in ["tamper", "destination", "arguments", "journal"] {
        let mut f = Fixture::new(true);
        let journal = f.stage();
        let staging = f.options.root.join(".runtime").join(&journal.staging);
        match problem {
            "tamper" => fs::write(staging.join("config/platform.env"), "tampered").unwrap(),
            "destination" => {
                io::private_directory(&f.options.root.join("data")).unwrap();
                fs::write(f.options.root.join("data/keep"), "preserve").unwrap();
            }
            "arguments" => f.options.first = "different".into(),
            "journal" => {
                let path = f.options.root.join(".runtime/setup.json");
                let mut value = io::read_json(&path).unwrap();
                value["staging"] = "../outside".into();
                io::write_json(&path, &value).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(initialize(&f.options, &f.system).is_err(), "{problem}");
        assert_eq!(f.system.bootstraps.get(), 1);
        if problem == "destination" {
            assert_eq!(
                fs::read_to_string(f.options.root.join("data/keep")).unwrap(),
                "preserve"
            );
        }
    }
}
#[test]
fn setup_lock_excludes_concurrent_initialization() {
    let f = Fixture::new(true);
    let runtime = f.options.root.join(".runtime");
    io::private_directory(&runtime).unwrap();
    let _lock = io::ExclusiveLock::acquire(&runtime.join("setup.lock")).unwrap();
    assert!(initialize(&f.options, &f.system).is_err());
    assert_eq!(f.system.bootstraps.get(), 0);
}
#[test]
fn private_bootstrap_stdin_and_environment_never_leak_through_errors() {
    let temp = tempfile::tempdir().unwrap();
    let error = dispatch_ci::process::isolated(
        &["/bin/sh", "-c", "/bin/cat >&2; exit 1"],
        temp.path(),
        2,
        &BTreeMap::new(),
        b"secret-initial-password",
    )
    .unwrap_err()
    .to_string();
    assert!(!error.contains("secret-initial-password"));
    assert!(error.contains("Bootstrap command failed"));
    dispatch_ci::process::isolated(
        &[
            "/bin/sh",
            "-c",
            "test -z \"$HOME\" && test \"$ONLY\" = expected",
        ],
        temp.path(),
        2,
        &BTreeMap::from([("ONLY".into(), "expected".into())]),
        b"",
    )
    .unwrap();
}
#[test]
fn complete_installation_keeps_a_rollback_copy_and_failed_self_check_keeps_current_manager() {
    let f = Fixture::new(true);
    initialize(&f.options, &f.system).unwrap();
    let root = &f.options.root;
    let updater = crate::updater::Updater::new(root, Environment::Production, &f.system).unwrap();
    let manager = root.join("management");
    fs::write(manager.join("runtime_artifact.py"), "previous launcher").unwrap();
    f.system.bad_manager.set(true);
    assert!(management::install_bundle(&updater).is_err());
    assert_eq!(
        fs::read_to_string(manager.join("runtime_artifact.py")).unwrap(),
        "previous launcher"
    );
    f.system.bad_manager.set(false);
    let lock =
        io::ExclusiveLock::acquire(&updater.platform.join("production-update.lock")).unwrap();
    assert!(management::install_bundle(&updater).is_err());
    assert_eq!(
        fs::read_to_string(manager.join("runtime_artifact.py")).unwrap(),
        "previous launcher"
    );
    drop(lock);
    management::install_bundle(&updater).unwrap();
    assert_ne!(
        fs::read_to_string(manager.join("runtime_artifact.py")).unwrap(),
        "previous launcher"
    );
    let backups: Vec<_> = fs::read_dir(root.join(".runtime"))
        .unwrap()
        .map(|p| {
            p.unwrap()
                .path()
                .join("previous-management/runtime_artifact.py")
        })
        .filter(|p| p.is_file())
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(
        fs::read_to_string(&backups[0]).unwrap(),
        "previous launcher"
    );
}
