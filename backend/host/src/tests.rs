use super::*;
use crate::io::{Native, Response, System};
use crate::updater::{Environment, Updater};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, HashMap, VecDeque},
    fs,
    io::Cursor,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Default)]
struct Fake {
    calls: RefCell<Vec<Vec<String>>>,
    responses: RefCell<HashMap<String, VecDeque<Value>>>,
    bodies: RefCell<HashMap<String, Vec<u8>>>,
    health: RefCell<Option<Value>>,
    fail_start: Cell<bool>,
    bad_health: Cell<bool>,
    elapsed: Cell<Duration>,
    root: RefCell<Option<(PathBuf, Environment)>>,
}
impl Fake {
    fn reply(&self, url: &str, values: Vec<Value>) {
        self.responses
            .borrow_mut()
            .insert(url.into(), values.into());
    }
    fn actions(&self) -> Vec<String> {
        self.calls
            .borrow()
            .iter()
            .filter(|a| a[0] == "systemctl")
            .map(|a| a[2].clone())
            .collect()
    }
}
impl System for Fake {
    fn command(
        &self,
        args: &[&str],
        cwd: Option<&Path>,
        timeout: u64,
        output: Option<&Path>,
    ) -> Result<Vec<u8>> {
        self.calls
            .borrow_mut()
            .push(args.iter().map(|s| s.to_string()).collect());
        if args[0] == "systemctl" {
            if args[2] == "start" && self.fail_start.replace(false) {
                return Err("start failed".into());
            }
            return Ok(vec![]);
        }
        if args[0] == "git" && args[1] == "fetch" {
            return Ok(vec![]);
        }
        if args[0] == "gh" {
            if let Some(target) = output {
                fs::write(
                    target,
                    self.bodies
                        .borrow()
                        .get(args[2])
                        .ok_or("Missing download")?,
                )?;
                return Ok(vec![]);
            }
            let mut replies = self.responses.borrow_mut();
            let queue = replies
                .get_mut(args[2])
                .ok_or_else(|| format!("Unexpected gh {}", args[2]))?;
            let value = if queue.len() > 1 {
                queue.pop_front().unwrap()
            } else {
                queue.front().unwrap().clone()
            };
            return Ok(serde_json::to_vec(&value)?);
        }
        Native.command(args, cwd, timeout, output)
    }
    fn request(&self, url: &str, head: bool, _follow: bool, _timeout: u64) -> Result<Response> {
        if url.starts_with("http://127.0.0.1:") {
            let value = if let Some(value) = self.health.borrow().as_ref() {
                value.clone()
            } else {
                let root = self.root.borrow();
                let (root, env) = root.as_ref().ok_or("No environment")?;
                let active = root.join(if *env == Environment::Dev {
                    ".build"
                } else {
                    "live"
                });
                let manifest = artifact::verify(&active, None)?;
                if self.bad_health.get() && manifest.version == "0.1.1" {
                    json!({"status":"broken"})
                } else {
                    json!({"status":"ready","release":manifest.digest,"runtime":"rust","environment":if *env==Environment::Dev {"preview"}else{"production"}})
                }
            };
            return Ok(Response {
                status: 200,
                location: None,
                body: Box::new(Cursor::new(serde_json::to_vec(&value)?)),
            });
        }
        if let Some(bytes) = self.bodies.borrow().get(url) {
            return Ok(Response {
                status: 200,
                location: None,
                body: Box::new(Cursor::new(bytes.clone())),
            });
        }
        let mut replies = self.responses.borrow_mut();
        let queue = replies
            .get_mut(url)
            .ok_or_else(|| format!("Unexpected URL {url}"))?;
        let value = if queue.len() > 1 {
            queue.pop_front().unwrap()
        } else {
            queue.front().unwrap().clone()
        };
        // A HEAD reply is its redirect target, or {status, location} for another redirect.
        let (status, location) = match (head, value.as_object()) {
            (true, Some(redirect)) => (
                redirect["status"].as_u64().unwrap() as u16,
                redirect["location"].as_str().map(Into::into),
            ),
            (true, None) => (302, value.as_str().map(Into::into)),
            (false, _) => (200, None),
        };
        Ok(Response {
            status,
            location,
            body: Box::new(Cursor::new(serde_json::to_vec(&value)?)),
        })
    }
    fn now(&self) -> f64 {
        1000.0 + self.elapsed.get().as_secs_f64()
    }
    fn monotonic(&self) -> Duration {
        self.elapsed.get()
    }
    fn sleep(&self, d: Duration) {
        self.elapsed.set(self.elapsed.get() + d);
    }
}
fn git(root: &Path, args: &[&str]) -> String {
    let mut all = vec![
        "git",
        "-c",
        "user.email=test@dispatch.test",
        "-c",
        "user.name=Test",
    ];
    all.extend_from_slice(args);
    String::from_utf8(Native.command(&all, Some(root), 30, None).unwrap())
        .unwrap()
        .trim()
        .into()
}
fn artifact(root: &Path, commit: &str, version: &str, host: bool) -> artifact::Manifest {
    fs::create_dir_all(root.join("dashboard")).unwrap();
    fs::create_dir_all(root.join("services/rust")).unwrap();
    fs::create_dir_all(root.join("tooling")).unwrap();
    fs::write(root.join("dashboard/index.html"), version).unwrap();
    fs::write(
        root.join("services/rust/dispatch-backend"),
        "#!/bin/sh\necho '{\"hostManagement\":1}'\n",
    )
    .unwrap();
    fs::write(
        root.join("tooling/build-info.json"),
        json!({"commit":commit,"hostManagement":if host {1}else{0}}).to_string(),
    )
    .unwrap();
    artifact::write_manifest(root, version).unwrap()
}
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    candidate: PathBuf,
    old: String,
    new: String,
    old_manifest: artifact::Manifest,
    new_manifest: artifact::Manifest,
    system: Fake,
    environment: Environment,
    /// The branch Dev's checkout follows in this test.
    branch: std::cell::Cell<&'static str>,
}
impl Fixture {
    fn new(environment: Environment) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(if environment == Environment::Dev {
            "dev"
        } else {
            "public"
        });
        io::private_directory(&root.join("config")).unwrap();
        fs::write(root.join("config/updater.json"),json!({"service":if environment==Environment::Dev {"dispatch-dev.service"}else{"dispatch-production.service"},"healthUrl":"http://127.0.0.1:5180/api/health"}).to_string()).unwrap();
        let (old, new) = if environment == Environment::Dev {
            git(&root, &["init", "-b", "dev"]);
            git(
                &root,
                &[
                    "remote",
                    "add",
                    "origin",
                    &format!("https://github.com/{REPOSITORY}.git"),
                ],
            );
            fs::write(
                root.join(".gitignore"),
                "/config\n/data\n/dsps\n/.build\n/.runtime\n/.platform.lock\n",
            )
            .unwrap();
            fs::write(root.join("app"), "old").unwrap();
            git(&root, &["add", "."]);
            git(&root, &["commit", "-m", "old"]);
            let old = git(&root, &["rev-parse", "HEAD"]);
            fs::write(root.join("app"), "new").unwrap();
            git(&root, &["commit", "-am", "new"]);
            let new = git(&root, &["rev-parse", "HEAD"]);
            git(&root, &["update-ref", "refs/remotes/origin/dev", &new]);
            git(&root, &["reset", "--hard", &old]);
            (old, new)
        } else {
            ("a".repeat(40), "b".repeat(40))
        };
        let system = Fake::default();
        system.root.replace(Some((root.clone(), environment)));
        let updater = Updater::new(&root, environment, &system).unwrap();
        let old_manifest = artifact(&updater.active, &old, "0.1.0", false);
        let candidate = updater.runtime.join("candidate");
        let new_manifest = artifact(&candidate, &new, "0.1.1", false);
        fs::write(root.join("data/private-sentinel"), "preserved").unwrap();
        Self {
            _temp: temp,
            root,
            candidate,
            old,
            new,
            old_manifest,
            new_manifest,
            system,
            environment,
            branch: std::cell::Cell::new("dev"),
        }
    }
    /// Move Dev's checkout onto main at the running commit, as the switch to one branch does,
    /// with main's newest merged commit being the new build.
    fn on_main(&self) {
        git(&self.root, &["checkout", "-q", "-B", "main"]);
        git(
            &self.root,
            &["update-ref", "refs/remotes/origin/main", &self.new],
        );
        self.branch.set("main");
    }
    fn updater(&self) -> Updater<'_> {
        Updater::new(&self.root, self.environment, &self.system).unwrap()
    }
    fn assert_old(&self) {
        let u = self.updater();
        assert_eq!(
            artifact::verify(&u.active, Some(&self.old)).unwrap(),
            self.old_manifest
        );
        assert!(!u.receipt.exists());
        assert_eq!(
            fs::read_to_string(self.root.join("data/private-sentinel")).unwrap(),
            "preserved"
        );
        if self.environment == Environment::Dev {
            assert_eq!(git(&self.root, &["rev-parse", "HEAD"]), self.old);
        }
    }
    fn receipt(&self) -> Value {
        if self.environment == Environment::Dev {
            json!({"commit":self.new,"oldCommit":self.old,"oldDigest":self.old_manifest.digest,"previous":"previous"})
        } else {
            json!({"oldDigest":self.old_manifest.digest,"newDigest":self.new_manifest.digest})
        }
    }
    fn run(&self) -> Value {
        json!({"id":17,"head_sha":self.new,"head_branch":self.branch.get(),"event":"push","status":"completed","conclusion":"success","head_repository":{"full_name":REPOSITORY},"run_attempt":1})
    }
    fn run_url(&self) -> String {
        format!(
            "repos/{REPOSITORY}/actions/workflows/checks.yml/runs?branch={}&event=push&head_sha={}&per_page=20",
            self.branch.get(),
            self.new
        )
    }
    fn package(&self) -> Vec<u8> {
        let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::default(),
        ));
        tar.append_dir_all(".", &self.candidate).unwrap();
        tar.into_inner().unwrap().finish().unwrap()
    }
    fn dev_download(&self) {
        let data = self.package();
        let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
        zip.start_file(
            "dispatch-dev.tar.gz",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        use std::io::Write;
        zip.write_all(&data).unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let record = json!({"id":42,"name":format!("dispatch-{}-{}",self.branch.get(),self.new),"expired":false,"size_in_bytes":bytes.len(),"digest":format!("sha256:{}",artifact::hash(&bytes))});
        self.system.reply(
            &format!("repos/{REPOSITORY}/actions/runs/17/artifacts"),
            vec![json!({"artifacts":[record]})],
        );
        self.system.bodies.borrow_mut().insert(
            format!("repos/{REPOSITORY}/actions/artifacts/42/zip"),
            bytes,
        );
    }
    fn production_release(&self) -> Value {
        let mut release = json!({"id":42,"tag_name":"v0.1.1","draft":false,"prerelease":false,"published_at":"2026-09-21T00:00:00Z","assets":[]});
        for (name, data) in [
            ("dispatch-platform-0.1.1.tar.gz", self.package()),
            (
                "release.json",
                fs::read(self.candidate.join("release.json")).unwrap(),
            ),
        ] {
            let url = format!("https://github.com/{REPOSITORY}/releases/download/v0.1.1/{name}");
            release["assets"].as_array_mut().unwrap().push(json!({"name":name,"state":"uploaded","size":data.len(),"digest":format!("sha256:{}",artifact::hash(&data)),"browser_download_url":url}));
            self.system.bodies.borrow_mut().insert(url, data);
        }
        self.system.reply(
            &format!("https://api.github.com/repos/{REPOSITORY}/git/ref/tags/v0.1.1"),
            vec![json!({"object":{"type":"commit","sha":self.new}})],
        );
        self.system.reply(
            &format!(
                "https://api.github.com/repos/{REPOSITORY}/compare/{}...main",
                self.new
            ),
            vec![json!({"status":"ahead"})],
        );
        release
    }
}
#[test]
fn activation_preserves_state_and_retains_verified_previous_runtime() {
    for env in [Environment::Dev, Environment::Production] {
        let f = Fixture::new(env);
        let u = f.updater();
        u.activate(&f.candidate, &f.new).unwrap();
        assert_eq!(
            artifact::verify(&u.active, Some(&f.new)).unwrap(),
            f.new_manifest
        );
        assert_eq!(
            artifact::verify(&u.previous, Some(&f.old)).unwrap(),
            f.old_manifest
        );
        assert_eq!(f.system.actions(), ["stop", "start"]);
        assert!(!u.receipt.exists());
        assert_eq!(
            fs::read_to_string(f.root.join("data/private-sentinel")).unwrap(),
            "preserved"
        );
        assert_eq!(
            fs::metadata(u.active.join("services/rust/dispatch-backend"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}
#[test]
fn failed_start_or_wrong_health_rolls_back_both_environments() {
    for env in [Environment::Dev, Environment::Production] {
        for health in [false, true] {
            let f = Fixture::new(env);
            if health {
                f.system.bad_health.set(true);
            } else {
                f.system.fail_start.set(true);
            }
            assert!(f.updater().activate(&f.candidate, &f.new).is_err());
            f.assert_old();
            assert_eq!(f.system.actions(), ["stop", "start", "stop", "start"]);
        }
    }
}
#[test]
fn every_activation_interruption_recovers_before_other_work() {
    for env in [Environment::Dev, Environment::Production] {
        for stage in 0..4 {
            let f = Fixture::new(env);
            let u = f.updater();
            io::write_json(&u.receipt, &f.receipt()).unwrap();
            if stage >= 1 {
                fs::rename(&u.active, &u.previous).unwrap();
            }
            if stage >= 2 {
                fs::rename(&f.candidate, &u.active).unwrap();
            }
            if stage >= 3 && env == Environment::Dev {
                git(&f.root, &["merge", "--ff-only", &f.new]);
            }
            u.recover().unwrap();
            f.assert_old();
            assert_eq!(f.system.actions(), ["stop", "start"]);
        }
    }
}
#[test]
fn corrupted_retained_runtime_keeps_recovery_receipt_and_never_starts() {
    for env in [Environment::Dev, Environment::Production] {
        let f = Fixture::new(env);
        let u = f.updater();
        io::write_json(&u.receipt, &f.receipt()).unwrap();
        fs::rename(&u.active, &u.previous).unwrap();
        fs::write(u.previous.join("dashboard/index.html"), "tampered").unwrap();
        assert!(u.recover().is_err());
        assert!(u.receipt.exists());
        assert_eq!(f.system.actions(), ["stop"]);
    }
}
#[test]
fn concurrent_timer_run_performs_no_update_or_recovery() {
    use fs2::FileExt;
    for env in [Environment::Dev, Environment::Production] {
        let f = Fixture::new(env);
        let u = f.updater();
        let lock =
            fs::File::create(u.platform.join(format!("{}-update.lock", env.name()))).unwrap();
        lock.lock_exclusive().unwrap();
        u.run_locked().unwrap();
        assert!(f.system.calls.borrow().is_empty());
    }
}
#[test]
fn dirty_changed_or_private_dev_source_is_not_overwritten() {
    for mode in ["dirty", "private", "branch"] {
        let f = Fixture::new(Environment::Dev);
        match mode {
            "dirty" => fs::write(f.root.join("app"), "unfinished").unwrap(),
            "private" => {
                git(&f.root, &["add", "-f", "config/updater.json"]);
                git(&f.root, &["commit", "-m", "private"]);
            }
            _ => {
                git(&f.root, &["switch", "-c", "unfinished"]);
            }
        }
        assert!(f.updater().activate(&f.candidate, &f.new).is_err());
        assert!(f.system.actions().is_empty());
    }
}
#[test]
fn invalid_receipts_cannot_move_any_runtime() {
    for env in [Environment::Dev, Environment::Production] {
        let f = Fixture::new(env);
        let u = f.updater();
        let mut record = f.receipt();
        record["oldDigest"] = json!("bad");
        io::write_json(&u.receipt, &record).unwrap();
        assert!(u.recover().is_err());
        assert!(f.system.actions().is_empty());
        assert!(u.receipt.exists());
    }
}
#[test]
fn source_and_artifact_tampering_are_rejected_before_service_stop() {
    for mode in ["source", "content", "link", "hardlink"] {
        let f = Fixture::new(Environment::Dev);
        match mode {
            "content" => fs::write(f.candidate.join("dashboard/index.html"), "tampered").unwrap(),
            "link" => {
                fs::remove_file(f.candidate.join("dashboard/index.html")).unwrap();
                symlink("/etc/passwd", f.candidate.join("dashboard/index.html")).unwrap();
            }
            "hardlink" => fs::hard_link(
                f.candidate.join("dashboard/index.html"),
                f.candidate.join("dashboard/extra"),
            )
            .unwrap(),
            _ => {}
        }
        assert!(
            f.updater()
                .activate(&f.candidate, if mode == "source" { &f.old } else { &f.new })
                .is_err()
        );
        assert!(f.system.actions().is_empty());
    }
}
#[test]
fn latest_workflow_rerun_supersedes_green_validation() {
    let f = Fixture::new(Environment::Dev);
    let mut bad = f.run();
    bad["run_attempt"] = json!(2);
    bad["conclusion"] = json!("failure");
    let runs = json!([f.run(), bad]);
    let selected = releases::latest_run(&runs, &f.new, "push", Some("dev"), false).unwrap();
    assert!(!releases::passed(selected));
    f.system
        .reply(&f.run_url(), vec![json!({"workflow_runs":runs})]);
    f.updater().run_locked().unwrap();
    f.assert_old();
    assert!(f.system.actions().is_empty());
}
#[test]
fn dev_download_installs_only_with_still_current_validation() {
    for revoke in [false, true] {
        let f = Fixture::new(Environment::Dev);
        f.dev_download();
        let mut later = f.run();
        if revoke {
            later["run_attempt"] = json!(2);
            later["conclusion"] = json!("failure");
        }
        f.system.reply(
            &f.run_url(),
            vec![
                json!({"workflow_runs":[f.run()]}),
                json!({"workflow_runs":[later]}),
            ],
        );
        f.updater().run_locked().unwrap();
        if revoke {
            f.assert_old();
            assert!(f.system.actions().is_empty());
        } else {
            assert_eq!(
                artifact::verify(&f.updater().active, None).unwrap(),
                f.new_manifest
            );
        }
    }
}
#[test]
fn dev_follows_main_once_its_checkout_is_on_main_and_nothing_else() {
    // Moving the checkout onto main at the running commit switches Dev over: it installs
    // main's newest merged build and fast-forwards along main.
    let f = Fixture::new(Environment::Dev);
    f.on_main();
    f.dev_download();
    f.system
        .reply(&f.run_url(), vec![json!({"workflow_runs":[f.run()]})]);
    f.updater().run_locked().unwrap();
    assert_eq!(
        artifact::verify(&f.updater().active, None).unwrap(),
        f.new_manifest
    );
    assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), f.new);
    assert_eq!(git(&f.root, &["branch", "--show-current"]), "main");
    // A build published for dev is not main's, even at the same commit.
    let f = Fixture::new(Environment::Dev);
    f.dev_download();
    f.on_main();
    f.system
        .reply(&f.run_url(), vec![json!({"workflow_runs":[f.run()]})]);
    assert!(f.updater().run_locked().is_err());
    f.assert_old();
    // Any other branch is refused rather than followed.
    let f = Fixture::new(Environment::Dev);
    git(&f.root, &["checkout", "-q", "-B", "feature"]);
    assert!(f.updater().run_locked().is_err());
    f.assert_old();
}
#[test]
fn production_download_rechecks_publication_and_records_failed_release() {
    for mode in ["success", "superseded", "failed"] {
        let f = Fixture::new(Environment::Production);
        let release = f.production_release();
        let mut latest = release.clone();
        if mode == "superseded" {
            latest["id"] = json!(43);
        }
        f.system.reply(
            &format!("https://api.github.com/repos/{REPOSITORY}/releases/latest"),
            vec![release.clone(), latest],
        );
        if mode == "failed" {
            f.system.fail_start.set(true);
        }
        let result = f.updater().run_locked();
        if mode == "success" {
            result.unwrap();
            assert_eq!(
                artifact::verify(&f.updater().active, None).unwrap(),
                f.new_manifest
            );
        } else {
            if mode == "failed" {
                assert!(result.is_err());
                assert_eq!(
                    io::read_json(&f.updater().status_file).unwrap()["failedReleaseId"],
                    42
                );
            } else {
                result.unwrap();
                assert!(f.system.actions().is_empty());
            }
            f.assert_old();
        }
    }
}
#[test]
fn production_installs_releases_published_under_either_repository_name() {
    // A release can report asset URLs under the name the repository had when it was made.
    let moved = "dillonlille/dispatch-platform";
    assert_ne!(moved, REPOSITORY);
    let f = Fixture::new(Environment::Production);
    let mut release = f.production_release();
    for asset in release["assets"].as_array_mut().unwrap() {
        let old = asset["browser_download_url"].as_str().unwrap().to_owned();
        let new = old.replace(REPOSITORY, moved);
        let bytes = f.system.bodies.borrow_mut().remove(&old).unwrap();
        f.system.bodies.borrow_mut().insert(new.clone(), bytes);
        asset["browser_download_url"] = json!(new);
    }
    f.system.reply(
        &format!("https://api.github.com/repos/{REPOSITORY}/releases/latest"),
        vec![release],
    );
    f.updater().run_locked().unwrap();
    assert_eq!(
        artifact::verify(&f.updater().active, None).unwrap(),
        f.new_manifest
    );
    // Only this repository's names count, never a look-alike or another path.
    for url in [
        format!("https://github.com/{moved}-mirror/releases/download/v0.1.1/release.json"),
        "https://github.com/other/dispatch-platform/releases/download/v0.1.1/release.json"
            .to_string(),
        format!("https://github.com/{moved}/releases/download/v0.1.0/release.json"),
        format!("https://github.com/{moved}/releases/download/v0.1.1/other.json"),
    ] {
        let f = Fixture::new(Environment::Production);
        let mut release = f.production_release();
        release["assets"][1]["browser_download_url"] = json!(url);
        f.system.reply(
            &format!("https://api.github.com/repos/{REPOSITORY}/releases/latest"),
            vec![release],
        );
        assert!(f.updater().run_locked().is_err(), "{url}");
        assert!(f.system.actions().is_empty(), "{url}");
        f.assert_old();
    }
}
#[test]
fn the_latest_release_shortcut_follows_a_move_between_repository_names() {
    // An updater asking under one name is redirected to the same page under the other.
    let moved = REPOSITORIES
        .into_iter()
        .find(|name| *name != REPOSITORY)
        .unwrap();
    let f = Fixture::new(Environment::Production);
    let old = format!("https://github.com/{REPOSITORY}/releases/latest");
    let new = format!("https://github.com/{moved}/releases/latest");
    f.system
        .reply(&old, vec![json!({"status":301,"location":new})]);
    f.system.reply(
        &new,
        vec![json!(format!(
            "https://github.com/{moved}/releases/tag/v0.1.1"
        ))],
    );
    assert_eq!(releases::latest_tag(&f.system).as_deref(), Some("v0.1.1"));
    // Before the move the shortcut answers directly.
    f.system.reply(
        &old,
        vec![json!(format!(
            "https://github.com/{REPOSITORY}/releases/tag/v0.1.2"
        ))],
    );
    assert_eq!(releases::latest_tag(&f.system).as_deref(), Some("v0.1.2"));
    // Redirects elsewhere, loops and tags under another repository are not answers.
    for reply in [
        json!({"status":301,"location":"https://github.com/other/dispatch-platform/releases/latest"}),
        json!({"status":301,"location":old}),
        json!({"status":301,"location":format!("https://github.com/{moved}/releases/tag/v0.1.1")}),
        json!("https://github.com/other/dispatch-platform/releases/tag/v0.1.1"),
        json!({"status":200,"location":format!("https://github.com/{moved}/releases/tag/v0.1.1")}),
    ] {
        f.system.reply(&old, vec![reply.clone()]);
        assert_eq!(releases::latest_tag(&f.system), None, "{reply}");
    }
}
#[test]
fn drafts_prereleases_and_same_or_older_versions_never_replace_runtime() {
    for change in [
        json!({"draft":true}),
        json!({"prerelease":true}),
        json!({"tag_name":"v0.1.1-rc.1"}),
        json!({"tag_name":"v00.1.1"}),
        json!({"published_at":null}),
    ] {
        let f = Fixture::new(Environment::Production);
        let mut release = f.production_release();
        release
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        f.system.reply(
            &format!("https://api.github.com/repos/{REPOSITORY}/releases/latest"),
            vec![release],
        );
        assert!(f.updater().run_locked().is_err());
        assert!(f.system.actions().is_empty());
    }
    for version in ["0.0.9", "0.1.0"] {
        let f = Fixture::new(Environment::Production);
        let mut release = f.production_release();
        release["tag_name"] = json!(format!("v{version}"));
        f.system.reply(
            &format!("https://api.github.com/repos/{REPOSITORY}/releases/latest"),
            vec![release],
        );
        f.updater().run_locked().unwrap();
        f.assert_old();
        assert!(f.system.actions().is_empty());
    }
}
#[test]
fn downloaded_size_digest_and_tag_ancestry_are_enforced() {
    for field in ["size", "digest", "browser_download_url", "ancestry"] {
        let f = Fixture::new(Environment::Production);
        let mut release = f.production_release();
        match field {
            "size" => release["assets"][0]["size"] = json!(1),
            "digest" => {
                release["assets"][0]["digest"] = json!(format!("sha256:{}", "0".repeat(64)))
            }
            "browser_download_url" => {
                release["assets"][0]["browser_download_url"] = json!("https://example.com/payload")
            }
            _ => f.system.reply(
                &format!(
                    "https://api.github.com/repos/{REPOSITORY}/compare/{}...main",
                    f.new
                ),
                vec![json!({"status":"diverged"})],
            ),
        }
        f.system.reply(
            &format!("https://api.github.com/repos/{REPOSITORY}/releases/latest"),
            vec![release],
        );
        assert!(f.updater().run_locked().is_err());
        assert!(f.system.actions().is_empty());
        f.assert_old();
    }
}
#[test]
fn installed_management_survives_old_runtime_and_source_rollback() {
    let f = Fixture::new(Environment::Dev);
    let u = f.updater();
    artifact(&u.active, &f.old, "0.1.0", true);
    management::install(&u).unwrap();
    let installed = management::directory(&u).join("dispatch-host");
    let bytes = fs::read(&installed).unwrap();
    artifact(&u.active, &f.old, "0.1.0", false);
    management::refresh(&u).unwrap();
    assert_eq!(fs::read(installed).unwrap(), bytes);
    u.verify().unwrap();
}
#[test]
fn production_adopts_the_updater_of_each_release_it_installs_and_only_then() {
    let f = Fixture::new(Environment::Production);
    let u = f.updater();
    // Today's updater came from the running release.
    artifact(&u.active, &f.old, "0.1.0", true);
    management::install(&u).unwrap();
    let installed = management::directory(&u).join("dispatch-host");
    let original = fs::read(&installed).unwrap();
    // An ordinary check leaves a hand-restored updater alone, even when it differs.
    fs::write(
        &installed,
        "#!/bin/sh\necho '{\"hostManagement\":1}' # restored\n",
    )
    .unwrap();
    f.system.reply(
        &format!("https://api.github.com/repos/{REPOSITORY}/releases/latest"),
        vec![json!({"id":41,"tag_name":"v0.1.0","draft":false,"prerelease":false,"published_at":"2026-09-21T00:00:00Z","assets":[]})],
    );
    u.run_locked().unwrap();
    assert!(fs::read_to_string(&installed).unwrap().contains("restored"));
    fs::write(&installed, &original).unwrap();
    // The next release brings its own updater, which replaces the installed one.
    let backend = f.candidate.join("services/rust/dispatch-backend");
    fs::write(
        &backend,
        "#!/bin/sh\necho '{\"hostManagement\":1}' # 0.1.1\n",
    )
    .unwrap();
    fs::write(
        f.candidate.join("tooling/build-info.json"),
        json!({"commit":f.new,"hostManagement":1}).to_string(),
    )
    .unwrap();
    artifact::write_manifest(&f.candidate, "0.1.1").unwrap();
    let release = f.production_release();
    f.system.reply(
        &format!("https://api.github.com/repos/{REPOSITORY}/releases/latest"),
        vec![release],
    );
    u.run_locked().unwrap();
    assert_eq!(artifact::verify(&u.active, None).unwrap().version, "0.1.1");
    assert!(!management::drift(&u).unwrap());
    assert!(fs::read_to_string(&installed).unwrap().contains("# 0.1.1"));
}
#[test]
fn broken_management_self_check_preserves_working_copy() {
    let f = Fixture::new(Environment::Dev);
    let u = f.updater();
    artifact(&u.active, &f.old, "0.1.0", true);
    management::install(&u).unwrap();
    let installed = management::directory(&u).join("dispatch-host");
    let bytes = fs::read(&installed).unwrap();
    fs::write(
        u.active.join("services/rust/dispatch-backend"),
        "#!/bin/sh\nexit 1\n",
    )
    .unwrap();
    artifact::write_manifest(&u.active, "0.1.0").unwrap();
    management::refresh(&u).unwrap();
    assert_eq!(fs::read(installed).unwrap(), bytes);
    assert!(management::drift(&u).unwrap());
}

#[test]
fn manifests_preserve_legacy_digest_order_and_metadata_when_promoted() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("bundle");
    let old = artifact(&root, &"a".repeat(40), "0.1.0", true);
    // Python's verifier hashes JSON insertion order, including nested entries.
    let mut value: Value = io::read_json(&root.join("release.json")).unwrap();
    value.as_object_mut().unwrap().shift_remove("digest");
    let mut reordered = serde_json::Map::new();
    for key in ["schema", "runtime", "files", "version", "format"] {
        reordered.insert(key.into(), value[key].clone());
    }
    let mut reordered = Value::Object(reordered);
    reordered["digest"] = json!(artifact::hash(&serde_json::to_vec(&reordered).unwrap()));
    fs::write(root.join("release.json"), reordered.to_string()).unwrap();
    assert_eq!(
        artifact::verify(&root, Some(&"a".repeat(40)))
            .unwrap()
            .digest,
        reordered["digest"]
    );
    let bytes = fs::read(root.join("services/rust/dispatch-backend")).unwrap();
    let promoted = artifact::retarget(&root, &"a".repeat(40), &"b".repeat(40)).unwrap();
    assert_ne!(promoted.digest, old.digest);
    assert_eq!(
        fs::read(root.join("services/rust/dispatch-backend")).unwrap(),
        bytes
    );
    assert_eq!(
        io::read_json(&root.join("tooling/build-info.json")).unwrap()["hostManagement"],
        1
    );
}
#[test]
fn a_stamped_release_changes_only_its_version_and_packs_what_unpack_accepts() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("build");
    let commit = "a".repeat(40);
    let built = artifact(&root, &commit, "0.0.19", true);
    assert!(artifact::stamp(&root, &"b".repeat(40), "0.0.20").is_err());
    let stamped = artifact::stamp(&root, &commit, "0.0.20").unwrap();
    assert_eq!(stamped.version, "0.0.20");
    assert_eq!(stamped.files, built.files);
    assert_ne!(stamped.digest, built.digest);
    let package = temp.path().join("release.tar.gz");
    artifact::pack(&root, &package).unwrap();
    assert!(artifact::pack(&root, &package).is_err());
    let unpacked = temp.path().join("unpacked");
    artifact::unpack(&package, &unpacked).unwrap();
    assert_eq!(artifact::verify(&unpacked, Some(&commit)).unwrap(), stamped);
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(
        fs::File::open(&package).unwrap(),
    ));
    let modes: BTreeMap<_, _> = archive
        .entries()
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            let header = entry.header();
            assert_eq!(header.entry_type(), tar::EntryType::Regular);
            assert_eq!(header.mtime().unwrap(), 0);
            (
                entry.path().unwrap().to_str().unwrap().to_owned(),
                header.mode().unwrap(),
            )
        })
        .collect();
    assert_eq!(modes["services/rust/dispatch-backend"], 0o755);
    assert_eq!(modes["release.json"], 0o644);
    assert_eq!(modes.len(), built.files.len() + 1);
}
#[test]
fn archives_reject_links_traversal_duplicates_sparse_files_and_oversized_entries() {
    use std::io::Write;
    for mode in [
        "traversal",
        "absolute",
        "backslash",
        "symlink",
        "hardlink",
        "sparse",
        "duplicate",
        "large",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let package = temp.path().join("bad.tar.gz");
        let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
            fs::File::create(&package).unwrap(),
            flate2::Compression::default(),
        ));
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o600);
        header.set_size(0);
        let name = match mode {
            "traversal" => "../outside",
            "absolute" => "/outside",
            "backslash" => "dashboard/..\\outside",
            _ => "dashboard/item",
        };
        header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
        if matches!(mode, "symlink" | "hardlink") {
            header.set_entry_type(if mode == "symlink" {
                tar::EntryType::Symlink
            } else {
                tar::EntryType::Link
            });
            header.set_link_name("/etc/passwd").unwrap();
        }
        if mode == "sparse" {
            header.set_entry_type(tar::EntryType::GNUSparse);
        }
        if mode == "large" {
            header.set_size(MAX_BYTES + 1);
        }
        header.set_cksum();
        if mode == "large" {
            drop(tar);
            let mut gzip = flate2::write::GzEncoder::new(
                fs::File::create(&package).unwrap(),
                flate2::Compression::default(),
            );
            gzip.write_all(header.as_bytes()).unwrap();
            gzip.finish().unwrap();
        } else {
            tar.append(&header, Cursor::new(vec![])).unwrap();
            if mode == "duplicate" {
                tar.append(&header, Cursor::new(vec![])).unwrap();
            }
            tar.into_inner().unwrap().finish().unwrap();
        }
        assert!(
            artifact::unpack(&package, &temp.path().join("candidate")).is_err(),
            "{mode}"
        );
        assert!(!temp.path().join("outside").exists());
    }
}
#[test]
fn existing_extraction_target_and_linked_root_are_rejected() {
    let f = Fixture::new(Environment::Production);
    let package = f.root.join("good.tar.gz");
    fs::write(&package, f.package()).unwrap();
    assert!(artifact::unpack(&package, &f.candidate).is_err());
    let alias = f.root.join("alias");
    symlink(&f.candidate, &alias).unwrap();
    assert!(artifact::verify(&alias, None).is_err());
}
#[test]
fn manifest_schema_paths_duplicates_and_retired_payloads_are_rejected() {
    for change in [
        "format",
        "schema",
        "duplicate",
        "path",
        "retired",
        "extra",
        "missing",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("bundle");
        artifact(&root, &"a".repeat(40), "0.1.0", false);
        let mut value = io::read_json(&root.join("release.json")).unwrap();
        match change {
            "format" => value["format"] = json!(2),
            "schema" => value["schema"] = json!(4),
            "duplicate" => {
                let entry = value["files"][0].clone();
                value["files"].as_array_mut().unwrap().push(entry);
            }
            "path" => value["files"][0]["path"] = json!("../private"),
            "retired" => {
                fs::write(root.join("tooling/old.js"), "retired").unwrap();
                value["files"] = serde_json::to_value(artifact::inventory(&root).unwrap()).unwrap();
            }
            "extra" => {
                fs::write(root.join("dashboard/extra"), "extra").unwrap();
            }
            _ => {
                fs::remove_file(root.join("dashboard/index.html")).unwrap();
            }
        }
        value.as_object_mut().unwrap().shift_remove("digest");
        value["digest"] = json!(artifact::hash(&serde_json::to_vec(&value).unwrap()));
        fs::write(root.join("release.json"), value.to_string()).unwrap();
        assert!(artifact::verify(&root, None).is_err(), "{change}");
    }
}
#[test]
fn health_requires_the_expected_environment_and_digest() {
    for env in [Environment::Dev, Environment::Production] {
        for field in ["environment", "release", "status"] {
            let f = Fixture::new(env);
            let mut health = json!({"environment":if env==Environment::Dev{"preview"}else{"production"},"release":f.new_manifest.digest,"status":"ready","runtime":"rust"});
            health[field] = json!("wrong");
            f.system.health.replace(Some(health));
            assert!(f.updater().activate(&f.candidate, &f.new).is_err());
            assert!(
                f.updater().receipt.exists(),
                "Unhealthy rollback remains recoverable"
            );
        }
    }
}
#[test]
fn production_failed_release_is_not_retried_and_latest_hint_never_authorizes_an_update() {
    let f = Fixture::new(Environment::Production);
    let release = f.production_release();
    let u = f.updater();
    io::write_json(
        &u.status_file,
        &json!({"status":"rolled_back","failedReleaseId":42}),
    )
    .unwrap();
    let url = format!("https://api.github.com/repos/{REPOSITORY}/releases/latest");
    f.system.reply(&url, vec![release]);
    u.run_locked().unwrap();
    assert!(f.system.actions().is_empty());
    f.system.reply(
        &format!("https://github.com/{REPOSITORY}/releases/latest"),
        vec![json!(format!(
            "https://github.com/{REPOSITORY}/releases/tag/v0.1.1"
        ))],
    );
    f.system.responses.borrow_mut().remove(&url);
    u.run_locked().unwrap();
    f.assert_old();
}
