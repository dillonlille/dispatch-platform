use super::*;
use crate::io::{Native, Response};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    io::{Cursor, Write},
    os::unix::fs::{PermissionsExt, symlink},
};

const WORKFLOW: &str = ".github/workflows/checks.yml";

// Only remote services, smoke execution and time are faked. Release directories,
// manifests, tar/ZIP packages, Git history and journal durability use real I/O.
struct Fake {
    calls: RefCell<Vec<Vec<String>>>,
    listed: RefCell<Vec<Value>>,
    runs: RefCell<Value>,
    artifact: RefCell<Value>,
    download: Vec<u8>,
    commit: String,
    digest: String,
    failure: RefCell<Option<String>>,
    elapsed: Cell<Duration>,
    unhealthy: Cell<bool>,
    health_error: Cell<bool>,
    /// The build digest Dev reports serving.
    dev: RefCell<String>,
    /// PR bodies GitHub serves, by number.
    bodies: RefCell<BTreeMap<u64, String>>,
    asset_error: Cell<bool>,
    wrong_tag: Cell<bool>,
    hide_release_once: Cell<bool>,
    comparison: RefCell<String>,
    /// Runs that skipped the core suite, so validated less than the full suite.
    partial: RefCell<BTreeSet<u64>>,
    /// Where the temporary checks branch points on GitHub.
    branch: RefCell<Option<String>>,
    /// The conclusion a dispatched run reaches.
    dispatched: Cell<&'static str>,
}
impl Fake {
    fn fail(&self, point: &str) {
        self.failure.replace(Some(point.into()));
    }
    fn maybe_fail(&self, point: &str) -> Result<()> {
        if self.failure.borrow().as_deref() == Some(point) {
            self.failure.replace(None);
            return Err(format!("Injected {point} interruption").into());
        }
        Ok(())
    }
    fn has_call(&self, words: &[&str]) -> bool {
        self.calls.borrow().iter().any(|c| {
            c.windows(words.len())
                .any(|s| s.iter().map(String::as_str).eq(words.iter().copied()))
        })
    }
    fn count(&self, words: &[&str]) -> usize {
        self.calls
            .borrow()
            .iter()
            .filter(|c| {
                c.iter()
                    .map(String::as_str)
                    .take(words.len())
                    .eq(words.iter().copied())
            })
            .count()
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
        let field = |name: &str| {
            args.iter()
                .find_map(|a| a.strip_prefix(&format!("{name}=")))
                .unwrap_or("")
                .to_owned()
        };
        let checks_ref = "refs/heads/release-checks/v1.0.0";
        if args[0] == "gh" && args[1] == "pr" && args[2] == "view" {
            let number: u64 = args[3].parse()?;
            return Ok(self
                .bodies
                .borrow()
                .get(&number)
                .ok_or("no such pull request")?
                .clone()
                .into_bytes());
        }
        let value = if args[0] == "gh" && args[1] == "api" {
            let endpoint = args[2]
                .strip_prefix(&format!("repos/{REPOSITORY}/"))
                .ok_or("Wrong repository")?;
            if endpoint == "releases?per_page=100" {
                if !self.listed.borrow().is_empty() && self.hide_release_once.replace(false) {
                    json!([[]])
                } else {
                    json!([self.listed.borrow().clone()])
                }
            } else if endpoint.starts_with("actions/workflows/") {
                json!({"workflow_runs":self.runs.borrow().clone()})
            } else if endpoint.starts_with("compare/") {
                json!({"status":*self.comparison.borrow()})
            } else if endpoint.starts_with("actions/runs/")
                && endpoint.ends_with("/artifacts?per_page=100")
            {
                // Every full run publishes the build, the dispatched one included.
                json!({"artifacts":[self.artifact.borrow().clone()]})
            } else if endpoint == "actions/artifacts/31/zip" {
                fs::write(output.ok_or("Expected download file")?, &self.download)?;
                self.maybe_fail("download")?;
                return Ok(vec![]);
            } else if let Some(run) = endpoint
                .strip_prefix("actions/runs/")
                .and_then(|s| s.strip_suffix("/jobs?filter=latest&per_page=100"))
            {
                let partial = self.partial.borrow().contains(&run.parse()?);
                json!({"jobs":[{"name":"build","conclusion":"success"},
                    {"name":"platform","conclusion":"success"},
                    {"name":"core","conclusion":if partial { "skipped" } else { "success" }}]})
            } else if endpoint.starts_with("git/matching-refs/tags/") {
                if self.listed.borrow().iter().any(|r| r["draft"] == false) || self.wrong_tag.get()
                {
                    json!([{"ref":"refs/tags/v1.0.0","object":{"type":"commit","sha":if self.wrong_tag.get() { "b".repeat(40) } else { self.commit.clone() }}}])
                } else {
                    json!([])
                }
            } else if endpoint == "git/matching-refs/heads/release-checks/v1.0.0" {
                let refs: Vec<_> = self
                    .branch
                    .borrow()
                    .iter()
                    .map(|sha| json!({"ref":checks_ref,"object":{"type":"commit","sha":sha}}))
                    .collect();
                json!(refs)
            } else if endpoint == "git/refs" {
                require(field("ref") == checks_ref, "Unexpected branch")?;
                require(self.branch.borrow().is_none(), "Reference already exists")?;
                self.branch.replace(Some(field("sha")));
                json!({ "ref": checks_ref })
            } else if endpoint == "git/refs/heads/release-checks/v1.0.0" {
                if args.contains(&"DELETE") {
                    self.branch.take().ok_or("Reference does not exist")?;
                    return Ok(vec![]);
                }
                require(args.contains(&"PATCH"), "Unexpected branch update")?;
                self.branch.replace(Some(field("sha")));
                json!({ "ref": checks_ref })
            } else if endpoint == "releases/9" && args.contains(&"PATCH") {
                self.listed.borrow_mut()[0]["draft"] = json!(false);
                self.listed.borrow_mut()[0]["published_at"] = json!("2026-09-21T00:00:00Z");
                self.maybe_fail("publication")?;
                self.listed.borrow()[0].clone()
            } else {
                return Err(format!("Unexpected API {endpoint}").into());
            }
        } else if args.starts_with(&["gh", "workflow", "run", "checks.yml"]) {
            let reference = args[args.iter().position(|s| *s == "--ref").unwrap() + 1];
            require(
                format!("refs/heads/{reference}") == checks_ref,
                "Unexpected dispatch",
            )?;
            let sha = self.branch.borrow().clone().ok_or("No such ref")?;
            let mut runs = self.runs.borrow_mut();
            let runs = runs.as_array_mut().unwrap();
            let id = runs.iter().filter_map(|r| r["id"].as_u64()).max().unwrap() + 1;
            runs.push(
                json!({"id":id,"run_attempt":1,"head_sha":sha,"event":"workflow_dispatch",
                "head_branch":reference,"status":"completed","conclusion":self.dispatched.get(),
                "path":WORKFLOW,"head_repository":{"full_name":REPOSITORY},
                "html_url":format!("https://example.invalid/run/{id}")}),
            );
            Value::Null
        } else if args.starts_with(&["gh", "release", "create"]) {
            self.listed.replace(vec![json!({"id":9,"tag_name":"v1.0.0","draft":true,"prerelease":false,
                "target_commitish":self.commit,"html_url":"https://example.invalid/release","assets":[]})]);
            self.maybe_fail("create-draft")?;
            Value::Null
        } else if args.starts_with(&["gh", "release", "upload"]) {
            let path = Path::new(args.last().unwrap());
            let record = json!({"name":path.file_name().unwrap().to_str().unwrap(),"state":"uploaded",
                "size":path.metadata()?.len(),"digest":format!("sha256:{}",artifact::file_hash(path)?)});
            self.listed.borrow_mut()[0]["assets"]
                .as_array_mut()
                .unwrap()
                .push(record);
            self.maybe_fail("upload")?;
            Value::Null
        } else if args[0].ends_with("/tsx") {
            self.maybe_fail("smoke")?;
            assert!(
                cwd.unwrap()
                    .join(".build/services/rust/dispatch-backend")
                    .is_file()
            );
            Value::Null
        } else if args.starts_with(&["git", "fetch"]) {
            Value::Null
        } else {
            return Native.command(args, cwd, timeout, output);
        };
        Ok(serde_json::to_vec(&value)?)
    }
    fn request(&self, url: &str, _head: bool, _follow: bool, _timeout: u64) -> Result<Response> {
        let (status, bytes) = if url == format!("{DEV}/api/health") {
            (
                200,
                serde_json::to_vec(&json!({"status":"ready","environment":"dev",
                "release":*self.dev.borrow()}))?,
            )
        } else if url.ends_with("/api/health") {
            if self.health_error.get() {
                return Err("network unavailable".into());
            }
            (
                200,
                serde_json::to_vec(&json!({"status":"ready","environment":"production",
                "release":if self.unhealthy.get() { "old" } else { &self.digest }}))?,
            )
        } else if url == format!("{PRODUCTION}/") {
            (
                200,
                br#"<script src="/assets/app.js"></script><link href="./assets/app.css">"#.to_vec(),
            )
        } else if url.starts_with(&format!("{PRODUCTION}/assets/")) {
            (
                if self.asset_error.get() { 503 } else { 200 },
                b"asset".to_vec(),
            )
        } else {
            return Err(format!("Unexpected URL {url}").into());
        };
        Ok(Response {
            status,
            location: None,
            body: Box::new(Cursor::new(bytes)),
        })
    }
    fn monotonic(&self) -> Duration {
        self.elapsed.get()
    }
    fn sleep(&self, duration: Duration) {
        self.elapsed.set(self.elapsed.get() + duration);
    }
}
fn git(root: &Path, args: &[&str]) -> String {
    String::from_utf8(
        Native
            .command(&[&["git"][..], args].concat(), Some(root), 30, None)
            .unwrap(),
    )
    .unwrap()
    .trim()
    .into()
}
/// Merges a PR's change into main through a merge commit, as the queue does.
fn merge_to_main(root: &Path, name: &str) -> String {
    git(root, &["checkout", "-q", "-b", name, "main"]);
    fs::write(root.join(name), name).unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-m", name]);
    git(root, &["checkout", "-q", "main"]);
    git(
        root,
        &[
            "merge",
            "--no-ff",
            "-m",
            &format!("Merge pull request #8 from dispatch-systems/{name}"),
            "-m",
            name,
            name,
        ],
    );
    git(root, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(root, &["rev-parse", "HEAD"])
}
struct Fixture {
    temp: tempfile::TempDir,
    root: PathBuf,
    system: Fake,
    /// What CI built: the version main's source names, before the release stamps its own.
    built: artifact::Manifest,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("dev");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "user.name", "Test"]);
        git(&root, &["config", "user.email", "test@dispatch.test"]);
        fs::write(root.join(".gitignore"), "/node_modules\n").unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        fs::create_dir_all(root.join("tooling/ci")).unwrap();
        fs::copy(
            source.join("tooling/ci/test-plan.json"),
            root.join("tooling/ci/test-plan.json"),
        )
        .unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "initial"]);
        let commit = merge_to_main(&root, "accepted");
        fs::create_dir_all(root.join("node_modules/.bin")).unwrap();
        fs::write(root.join("node_modules/.bin/tsx"), "fake smoke").unwrap();
        let candidate = temp.path().join("candidate");
        for name in [
            "dashboard/index.html",
            "services/rust/dispatch-backend",
            "tooling/build-info.json",
        ] {
            fs::create_dir_all(candidate.join(name).parent().unwrap()).unwrap();
            fs::write(
                candidate.join(name),
                if name.ends_with(".json") {
                    json!({"commit":commit}).to_string()
                } else {
                    "fixture".into()
                },
            )
            .unwrap();
        }
        let built = artifact::write_manifest(&candidate, "0.9.0").unwrap();
        let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut tar = tar::Builder::new(gzip);
        tar.append_dir_all(".", &candidate).unwrap();
        let archive = tar.into_inner().unwrap().finish().unwrap();
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file(
            "dispatch-dev.tar.gz",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(&archive).unwrap();
        let download = zip.finish().unwrap().into_inner();
        // Production reports the digest of the build stamped with the release's version.
        let digest = artifact::stamp(&candidate, &commit, "1.0.0")
            .unwrap()
            .digest;
        let run = json!({"id":5,"run_attempt":1,"head_sha":commit,"event":"push","head_branch":"main",
            "status":"completed","conclusion":"success","path":WORKFLOW,
            "head_repository":{"full_name":REPOSITORY},"html_url":"https://example.invalid/run/5"});
        let system = Fake {
            calls: RefCell::new(vec![]),
            listed: RefCell::new(vec![]),
            runs: RefCell::new(json!([run])),
            artifact: RefCell::new(
                json!({"id":31,"name":format!("dispatch-main-{commit}"),"expired":false,
                "size_in_bytes":download.len(),"digest":format!("sha256:{}",artifact::hash(&download))}),
            ),
            download,
            commit: commit.clone(),
            digest,
            failure: RefCell::new(None),
            elapsed: Cell::new(Duration::ZERO),
            unhealthy: Cell::new(false),
            health_error: Cell::new(false),
            dev: RefCell::new(built.digest.clone()),
            bodies: RefCell::new(BTreeMap::new()),
            asset_error: Cell::new(false),
            wrong_tag: Cell::new(false),
            hide_release_once: Cell::new(false),
            comparison: RefCell::new("ahead".into()),
            partial: RefCell::new(BTreeSet::new()),
            branch: RefCell::new(None),
            dispatched: Cell::new("success"),
        };
        Self {
            temp,
            root,
            system,
            built,
        }
    }
    fn release(&self) -> Release<'_> {
        let options = Options {
            stage: Stage::Run,
            version: Some("1.0.0".into()),
            root: self.root.clone(),
            bump: "patch".into(),
            commit: None,
            notes: None,
            releases: None,
        };
        Release::new(
            &self.system,
            &options,
            "1.0.0",
            self.temp.path().to_path_buf(),
        )
    }
    fn prepare(&self) -> assets::Prepared {
        let release = self.release();
        let prepared = release.prepare(&self.system.commit).unwrap();
        fs::write(&release.notes, "Release notes\n").unwrap();
        prepared
    }
    fn draft(&self) -> assets::Prepared {
        let prepared = self.prepare();
        let release = self.release();
        release.smoke(&prepared).unwrap();
        release.ensure_draft(&prepared).unwrap();
        prepared
    }
}

#[test]
fn legacy_cli_defaults_and_explicit_stages_are_validated_before_effects() {
    let parse =
        |args: &[&str]| Options::parse(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    assert_eq!(parse(&["--root", "/checkout"]).unwrap().stage, Stage::Run);
    assert_eq!(
        parse(&["prepare", "1.0.0", "--root", "/checkout"])
            .unwrap()
            .stage,
        Stage::Prepare
    );
    for args in [
        vec!["publish", "bad", "--root", "/checkout"],
        vec!["--root", "/a", "--root", "/b"],
        vec!["status"],
        vec!["--root", "/a", "--bump", "bad"],
        vec!["--root", "/a", "--dev-commit", "HEAD"],
    ] {
        assert!(parse(&args).is_err());
    }
    assert_eq!(
        parse(&["--root", "/checkout", "--commit", "HEAD"])
            .unwrap()
            .commit
            .as_deref(),
        Some("HEAD")
    );
    assert_eq!(next_version("0.0.9", "patch").unwrap(), "0.0.10");
    assert_eq!(next_version("1.4.9", "minor").unwrap(), "1.5.0");
    assert_eq!(next_version("1.4.9", "major").unwrap(), "2.0.0");
    assert!(next_version("1.0.0-dev.0", "patch").is_err());
}

#[test]
fn failed_or_pending_newer_checks_never_fall_back_to_older_success() {
    let f = Fixture::new();
    let release = f.release();
    for (status, conclusion) in [
        ("completed", json!("failure")),
        ("in_progress", Value::Null),
    ] {
        let mut newest = f.system.runs.borrow()[0].clone();
        newest["id"] = json!(6);
        newest["status"] = json!(status);
        newest["conclusion"] = conclusion;
        f.system
            .runs
            .borrow_mut()
            .as_array_mut()
            .unwrap()
            .push(newest);
        assert!(release.checked_source(&f.system.commit).is_err());
        f.system.runs.borrow_mut().as_array_mut().unwrap().pop();
    }
    let mut skipped = f.system.runs.borrow()[0].clone();
    skipped["id"] = json!(6);
    skipped["conclusion"] = json!("skipped");
    f.system
        .runs
        .borrow_mut()
        .as_array_mut()
        .unwrap()
        .push(skipped);
    assert_eq!(release.checked_source(&f.system.commit).unwrap()["id"], 5);
    f.system.comparison.replace("diverged".into());
    assert!(release.prepare(&f.system.commit).is_err());
    assert!(!release.output.exists());
}

#[test]
fn interrupted_preparation_is_atomic_and_retries_without_overwriting_assets() {
    let f = Fixture::new();
    let release = f.release();
    io::private_directory(&release.directory).unwrap();
    release.record_commit(&f.system.commit).unwrap();
    f.system.fail("download");
    assert!(release.prepare(&f.system.commit).is_err());
    assert!(!release.output.exists());
    assert_eq!(
        release.journal().unwrap().commit.as_deref(),
        Some(f.system.commit.as_str())
    );
    let recovered = f.prepare();
    let bytes = fs::read(release.output.join("provenance.json")).unwrap();
    f.system.calls.borrow_mut().clear();
    assert_eq!(
        release.prepare(&f.system.commit).unwrap().runtime_digest,
        recovered.runtime_digest
    );
    assert!(f.system.calls.borrow().is_empty());
    assert_eq!(
        fs::read(release.output.join("provenance.json")).unwrap(),
        bytes
    );
    assert_eq!(
        release.output.metadata().unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[test]
fn corrupt_saved_assets_and_incomplete_legacy_directories_stop_without_deletion() {
    for name in [
        "dispatch-platform-1.0.0.tar.gz",
        "release.json",
        "provenance.json",
        "SHA256SUMS",
    ] {
        let f = Fixture::new();
        let release = f.release();
        f.prepare();
        fs::write(release.output.join(name), "corrupted").unwrap();
        assert!(release.prepare(&f.system.commit).is_err());
        assert_eq!(
            fs::read_to_string(release.output.join(name)).unwrap(),
            "corrupted"
        );
    }
    let f = Fixture::new();
    let release = f.release();
    io::private_directory(&release.output).unwrap();
    fs::write(release.output.join("private-sentinel"), "preserved").unwrap();
    assert!(release.prepare(&f.system.commit).is_err());
    assert!(release.output.join("private-sentinel").is_file());
}

#[test]
fn preparation_rejects_expired_or_mismatched_artifacts_and_linked_saved_files() {
    let f = Fixture::new();
    let release = f.release();
    f.system.artifact.borrow_mut()["expired"] = json!(true);
    assert!(release.prepare(&f.system.commit).is_err());
    assert!(!release.output.exists());
    f.system.artifact.borrow_mut()["expired"] = json!(false);
    f.system.artifact.borrow_mut()["digest"] = json!(format!("sha256:{}", "0".repeat(64)));
    assert!(release.prepare(&f.system.commit).is_err());
    assert!(!release.output.exists());
    let f = Fixture::new();
    let release = f.release();
    f.prepare();
    fs::rename(
        release.output.join("SHA256SUMS"),
        release.directory.join("outside"),
    )
    .unwrap();
    symlink(
        release.directory.join("outside"),
        release.output.join("SHA256SUMS"),
    )
    .unwrap();
    assert!(release.prepared(None).is_err());
}

#[test]
fn partial_uploads_and_lost_draft_creation_responses_resume_without_duplicates() {
    for failure in ["create-draft", "upload"] {
        let f = Fixture::new();
        let prepared = f.prepare();
        let release = f.release();
        release.smoke(&prepared).unwrap();
        f.system.fail(failure);
        assert!(release.ensure_draft(&prepared).is_err());
        assert!(!release.output.join("draft-verification.json").exists());
        release.ensure_draft(&prepared).unwrap();
        assert_eq!(
            f.system.listed.borrow()[0]["assets"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        assert!(!f.system.has_call(&["PATCH"]));
        let calls = f.system.calls.borrow();
        assert_eq!(
            calls
                .iter()
                .filter(|c| c.starts_with(&["gh".into(), "release".into(), "create".into()]))
                .count(),
            1
        );
        assert!(!calls.iter().flatten().any(|a| a == "--clobber"));
    }
}

#[test]
fn delayed_draft_visibility_is_awaited_before_uploading() {
    let f = Fixture::new();
    let prepared = f.prepare();
    f.system.hide_release_once.set(true);
    f.release().ensure_draft(&prepared).unwrap();
    assert!(f.system.elapsed.get() >= Duration::from_secs(3));
    assert_eq!(
        f.system.listed.borrow()[0]["assets"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    assert!(!f.system.has_call(&["PATCH"]));
}

#[test]
fn conflicting_uploads_or_wrong_tags_never_publish() {
    for corruption in ["digest", "size", "state", "extra", "target", "tag"] {
        let f = Fixture::new();
        let prepared = f.draft();
        let release = f.release();
        match corruption {
            "digest" => {
                f.system.listed.borrow_mut()[0]["assets"][0]["digest"] = json!("sha256:bad")
            }
            "size" => f.system.listed.borrow_mut()[0]["assets"][0]["size"] = json!(0),
            "state" => f.system.listed.borrow_mut()[0]["assets"][0]["state"] = json!("starter"),
            "extra" => {
                let extra = f.system.listed.borrow()[0]["assets"][0].clone();
                f.system.listed.borrow_mut()[0]["assets"]
                    .as_array_mut()
                    .unwrap()
                    .push(extra);
            }
            "target" => f.system.listed.borrow_mut()[0]["target_commitish"] = json!("b".repeat(40)),
            _ => f.system.wrong_tag.set(true),
        }
        f.system.calls.borrow_mut().clear();
        assert!(release.publish(&prepared).is_err(), "{corruption}");
        assert!(!f.system.has_call(&["PATCH"]));
    }
}

#[test]
fn prepare_stops_at_draft_and_publish_checks_again_then_completes() {
    let f = Fixture::new();
    let release = f.release();
    io::private_directory(&release.directory).unwrap();
    fs::write(&release.notes, "Notes").unwrap();
    assert_eq!(
        release.execute(Stage::Prepare, None).unwrap()["stage"],
        "draft-verified"
    );
    assert_eq!(f.system.listed.borrow()[0]["draft"], true);
    assert!(!release.journal().unwrap().complete);
    f.system.runs.borrow_mut()[0]["conclusion"] = json!("failure");
    assert!(release.execute(Stage::Publish, None).is_err());
    assert!(!f.system.has_call(&["PATCH"]));
    f.system.runs.borrow_mut()[0]["conclusion"] = json!("success");
    assert_eq!(
        release.execute(Stage::Publish, None).unwrap()["stage"],
        "complete"
    );
    assert_eq!(f.system.listed.borrow()[0]["draft"], false);
    assert!(
        release
            .output
            .join("deployment-verification.json")
            .is_file()
    );
    assert!(release.journal().unwrap().complete);
}

#[test]
fn publication_response_loss_and_production_failure_resume_without_republishing_or_smoking() {
    for failure in ["publication", "health", "assets"] {
        let f = Fixture::new();
        f.draft();
        let release = f.release();
        if failure == "publication" {
            f.system.fail("publication");
        } else if failure == "health" {
            f.system.unhealthy.set(true);
        } else {
            f.system.asset_error.set(true);
        }
        assert!(release.execute(Stage::Publish, None).is_err());
        assert_eq!(f.system.listed.borrow()[0]["draft"], false);
        assert!(!release.journal().unwrap().complete);
        f.system.unhealthy.set(false);
        f.system.asset_error.set(false);
        f.system.calls.borrow_mut().clear();
        fs::remove_dir_all(f.root.join("node_modules")).unwrap();
        assert_eq!(
            release.execute(Stage::Publish, None).unwrap()["stage"],
            "complete"
        );
        assert!(!f.system.has_call(&["PATCH"]));
        assert!(!f.system.has_call(&["--smoke-only"]));
        assert!(!f.system.has_call(&["gh", "workflow", "run"]));
    }
}

#[test]
fn smoke_failure_stops_draft_creation_and_publish_needs_preparation() {
    let f = Fixture::new();
    let release = f.release();
    assert!(release.execute(Stage::Publish, None).is_err());
    assert!(!release.output.exists());
    f.system.fail("smoke");
    assert!(release.execute(Stage::Prepare, None).is_err());
    assert!(release.output.is_dir());
    assert!(f.system.listed.borrow().is_empty());
    assert!(!release.output.join("smoke-verification.json").exists());
}

#[test]
fn status_is_read_only_even_for_missing_preparation() {
    let f = Fixture::new();
    let release = f.release();
    let head = git(&f.root, &["rev-parse", "HEAD"]);
    assert!(release.execute(Stage::Status, None).unwrap()["prepared"].is_null());
    assert!(!release.directory.exists());
    assert!(!f.system.has_call(&["git", "fetch"]));
    assert!(!f.system.has_call(&["PATCH"]));
    assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), head);
    assert!(git(&f.root, &["status", "--porcelain"]).is_empty());
    f.prepare();
    f.system.calls.borrow_mut().clear();
    let before = fs::read(release.output.join("provenance.json")).unwrap();
    assert_eq!(
        release.execute(Stage::Status, None).unwrap()["prepared"]["valid"],
        true
    );
    assert_eq!(
        fs::read(release.output.join("provenance.json")).unwrap(),
        before
    );
    assert!(!release.journal_path().exists());
    assert!(!release.directory.join(".release.lock").exists());
    f.system.health_error.set(true);
    assert!(release.execute(Stage::Status, None).unwrap()["production"]["problem"].is_string());
}

#[test]
fn unfinished_discovery_covers_a_pinned_commit_before_draft_and_published_before_verification() {
    let f = Fixture::new();
    let release = f.release();
    assert!(unfinished(&release.directory, &[]).unwrap().is_none());
    io::private_directory(&release.directory).unwrap();
    release.record_commit(&f.system.commit).unwrap();
    assert_eq!(
        unfinished(&release.directory, &[]).unwrap().as_deref(),
        Some("1.0.0")
    );
    let other = json!({"tag_name":"v2.0.0","draft":true});
    assert!(unfinished(&release.directory, &[other]).is_err());
    let listed = json!({"tag_name":"v1.0.0","draft":false});
    assert_eq!(
        unfinished(&release.directory, &[listed])
            .unwrap()
            .as_deref(),
        Some("1.0.0")
    );
    // Journals from releases that went through a release PR still read.
    let mut legacy = serde_json::to_value(release.journal().unwrap()).unwrap();
    legacy["devCommit"] = json!(f.system.commit);
    io::write_json(&release.journal_path(), &legacy).unwrap();
    let mut journal = release.journal().unwrap();
    assert_eq!(
        journal.dev_commit.as_deref(),
        Some(f.system.commit.as_str())
    );
    journal.complete = true;
    release.save(&journal).unwrap();
    assert!(unfinished(&release.directory, &[]).unwrap().is_none());
}

#[test]
fn legacy_history_without_receipts_does_not_reopen_superseded_releases() {
    let f = Fixture::new();
    let release = f.release();
    io::private_directory(&release.directory.join("v0.0.3")).unwrap();
    let listed = vec![json!({"tag_name":"v1.0.0","draft":false,"prerelease":false})];
    assert!(unfinished(&release.directory, &listed).unwrap().is_none());
    io::private_directory(&release.output).unwrap();
    assert_eq!(
        unfinished(&release.directory, &listed).unwrap().as_deref(),
        Some("1.0.0")
    );
    fs::remove_dir(&release.output).unwrap();
    let mut journal = release.journal().unwrap();
    journal.version = "0.0.3".into();
    io::write_json(
        &release.directory.join(".v0.0.3-state.json"),
        &serde_json::to_value(journal).unwrap(),
    )
    .unwrap();
    assert_eq!(
        unfinished(&release.directory, &listed).unwrap().as_deref(),
        Some("0.0.3")
    );
}

#[test]
fn locking_prevents_overlapping_mutations() {
    let f = Fixture::new();
    let release = f.release();
    io::private_directory(&release.directory).unwrap();
    let lock = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(release.directory.join(".release.lock"))
        .unwrap();
    lock.try_lock_exclusive().unwrap();
    assert!(
        release
            .execute(Stage::Prepare, None)
            .unwrap_err()
            .to_string()
            .contains("Another release")
    );
    assert!(f.system.calls.borrow().is_empty());
}

#[test]
fn release_lock_is_released_even_while_a_child_retains_its_descriptor() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("lock");
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    file.try_lock_exclusive().unwrap();
    // dup shares the same open file description as a descriptor inherited
    // between fork and exec, without forking from a multithreaded test process.
    let inherited = file.try_clone().unwrap();
    let next = OpenOptions::new().write(true).open(&path).unwrap();
    assert!(next.try_lock_exclusive().is_err());
    drop(ReleaseLock(file));
    next.try_lock_exclusive().unwrap();
    drop(inherited);
}

#[test]
fn staged_smoke_executables_tolerate_a_briefly_inherited_writable_descriptor() {
    let mut executable = tempfile::NamedTempFile::new().unwrap();
    executable.write_all(b"#!/bin/sh\nprintf ready\n").unwrap();
    executable
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o700))
        .unwrap();
    let inherited = executable.as_file().try_clone().unwrap();
    let executable = executable.into_temp_path();
    assert_eq!(
        std::process::Command::new(&executable)
            .spawn()
            .unwrap_err()
            .raw_os_error(),
        Some(libc::ETXTBSY)
    );
    let release_descriptor = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(50));
        drop(inherited);
    });
    let result = Native.command(&[executable.to_str().unwrap()], None, 2, None);
    release_descriptor.join().unwrap();
    assert_eq!(result.unwrap(), b"ready");
}

#[test]
fn busy_executable_retry_respects_the_command_deadline() {
    let mut executable = tempfile::NamedTempFile::new().unwrap();
    executable.write_all(b"#!/bin/sh\nexit 0\n").unwrap();
    executable
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o700))
        .unwrap();
    let error = Native
        .command(&[executable.path().to_str().unwrap()], None, 0, None)
        .unwrap_err();
    assert_eq!(
        error
            .downcast_ref::<std::io::Error>()
            .unwrap()
            .raw_os_error(),
        Some(libc::ETXTBSY)
    );
}

#[test]
fn the_release_publishes_mains_build_under_its_own_version() {
    let f = Fixture::new();
    let prepared = f.prepare();
    let release = f.release();
    let manifest: artifact::Manifest =
        serde_json::from_value(io::read_json(&release.output.join("release.json")).unwrap())
            .unwrap();
    assert_eq!(manifest.version, "1.0.0");
    assert_eq!(manifest.files, f.built.files);
    assert_eq!(manifest.digest, prepared.runtime_digest);
    assert_ne!(manifest.digest, f.built.digest);
    let unpacked = f.temp.path().join("unpacked");
    artifact::unpack(
        &release.output.join("dispatch-platform-1.0.0.tar.gz"),
        &unpacked,
    )
    .unwrap();
    assert_eq!(
        artifact::verify(&unpacked, Some(&f.system.commit)).unwrap(),
        manifest
    );
}

#[test]
fn the_release_pins_mains_head_and_only_an_unprepared_pin_moves() {
    let f = Fixture::new();
    let release = f.release();
    io::private_directory(&release.directory).unwrap();
    assert_eq!(release.pin(None).unwrap(), f.system.commit);
    // Main moves on; a resumed release keeps its commit until --commit names another.
    let later = merge_to_main(&f.root, "later");
    assert_eq!(release.pin(None).unwrap(), f.system.commit);
    assert_eq!(release.pin(Some("origin/main")).unwrap(), later);
    assert_eq!(
        release.journal().unwrap().commit.as_deref(),
        Some(later.as_str())
    );
    git(&f.root, &["checkout", "-q", "-b", "side", "main"]);
    fs::write(f.root.join("side"), "unmerged").unwrap();
    git(&f.root, &["add", "."]);
    git(&f.root, &["commit", "-m", "side"]);
    let error = release.pin(Some("side")).unwrap_err().to_string();
    assert!(error.contains("must be on main"), "{error}");
    assert_eq!(
        release.journal().unwrap().commit.as_deref(),
        Some(later.as_str())
    );
    assert_eq!(
        release.pin(Some(&f.system.commit)).unwrap(),
        f.system.commit
    );
    f.prepare();
    assert!(release.pin(Some(&later)).is_err());
    assert_eq!(release.pin(None).unwrap(), f.system.commit);
}

#[test]
fn a_release_needs_something_new_on_main_since_the_previous_one() {
    let f = Fixture::new();
    git(
        &f.root,
        &["tag", "v0.9.0", &format!("{}^1", f.system.commit)],
    );
    f.system.listed.replace(vec![
        json!({"tag_name":"v0.9.0","draft":false,"prerelease":false}),
    ]);
    f.system.comparison.replace("identical".into());
    let release = f.release();
    io::private_directory(&release.directory).unwrap();
    let error = release.pin(None).unwrap_err().to_string();
    assert!(error.contains("nothing new since v0.9.0"), "{error}");
    assert!(release.journal().unwrap().commit.is_none());
    f.system.comparison.replace("ahead".into());
    assert_eq!(release.pin(None).unwrap(), f.system.commit);
    let compared = format!("repos/{REPOSITORY}/compare/v0.9.0...{}", f.system.commit);
    assert!(f.system.has_call(&["gh", "api", &compared]));
}

#[test]
fn missing_notes_are_generated_from_the_merged_prs() {
    for served in [true, false] {
        let f = Fixture::new();
        git(
            &f.root,
            &["tag", "v0.9.0", &format!("{}^1", f.system.commit)],
        );
        f.system.listed.replace(vec![
            json!({"tag_name":"v0.9.0","draft":false,"prerelease":false}),
        ]);
        if served {
            f.system.bodies.borrow_mut().insert(
                8,
                "Problem\n\nIt broke.\n\nChange\n\nThe accepted change.\nIn one paragraph.\n\nMore.\n\nVerification\n\nTests.\n".into(),
            );
        }
        let release = f.release();
        io::private_directory(&release.directory).unwrap();
        let prepared = release.prepare(&f.system.commit).unwrap();
        release.ensure_draft(&prepared).unwrap();
        let notes = fs::read_to_string(&release.notes).unwrap();
        assert_eq!(
            notes,
            if served {
                "- Accepted. The accepted change. In one paragraph.\n\nIncludes [#8](https://github.com/dispatch-systems/dispatch-platform/pull/8).\n"
            } else {
                "- Accepted.\n\nIncludes [#8](https://github.com/dispatch-systems/dispatch-platform/pull/8).\n"
            }
        );
        assert_eq!(
            fs::read_to_string(release.output.join("notes.md")).unwrap(),
            notes
        );
    }
    // Notes already written are kept.
    let f = Fixture::new();
    let prepared = f.prepare();
    f.release().ensure_draft(&prepared).unwrap();
    assert_eq!(
        fs::read_to_string(&f.release().notes).unwrap(),
        "Release notes\n"
    );
}

#[test]
fn preparation_requires_dev_to_serve_the_build() {
    let f = Fixture::new();
    f.system.dev.replace("another build".into());
    let release = f.release();
    let error = release.prepare(&f.system.commit).unwrap_err().to_string();
    assert!(error.contains("Dev is not serving"), "{error}");
    assert!(!release.output.exists());
    f.system.dev.replace(f.built.digest.clone());
    assert_eq!(
        release.prepare(&f.system.commit).unwrap().commit,
        f.system.commit
    );
}

#[test]
fn a_commit_without_a_full_run_gets_one_on_a_temporary_branch_before_preparation() {
    let f = Fixture::new();
    f.system.partial.borrow_mut().insert(5);
    f.system.dispatched.set("failure");
    let release = f.release();
    io::private_directory(&release.directory).unwrap();
    fs::write(&release.notes, "Notes").unwrap();
    let error = release
        .execute(Stage::Prepare, None)
        .unwrap_err()
        .to_string();
    assert!(error.contains("Checks ended with failure"), "{error}");
    assert!(!release.output.exists());
    assert_eq!(
        f.system.branch.borrow().as_deref(),
        Some(f.system.commit.as_str())
    );
    // A rerun awaits that same run instead of starting another.
    assert!(release.execute(Stage::Prepare, None).is_err());
    assert_eq!(f.system.count(&["gh", "workflow", "run"]), 1);
    // Rerunning its failed jobs passes it; the release continues and drops the branch.
    f.system.runs.borrow_mut()[1]["conclusion"] = json!("success");
    assert_eq!(
        release.execute(Stage::Prepare, None).unwrap()["stage"],
        "draft-verified"
    );
    assert_eq!(f.system.count(&["gh", "workflow", "run"]), 1);
    assert!(f.system.branch.borrow().is_none());
    assert_eq!(release.prepared(None).unwrap().commit, f.system.commit);
}
