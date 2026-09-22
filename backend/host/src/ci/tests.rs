use super::*;
use crate::io::{Native, Response};
use dispatch_ci::policy::WORKFLOW;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::{BTreeMap, VecDeque},
    io::Cursor,
    os::unix::fs::symlink,
    path::PathBuf,
};

#[derive(Default)]
struct Fake {
    json: RefCell<BTreeMap<String, VecDeque<Value>>>,
    bytes: RefCell<BTreeMap<String, Vec<u8>>>,
}
fn context() -> Context {
    Context {
        commit: "a".repeat(40),
        base: "b".repeat(40),
        head: "c".repeat(40),
        tree: "d".repeat(40),
    }
}
fn run_record() -> Value {
    json!({"id":5,"run_attempt":1,"head_sha":context().head,"event":"pull_request","status":"completed","conclusion":"success","path":WORKFLOW,"head_repository":{"full_name":crate::REPOSITORY}})
}
fn endpoint(path: &str) -> String {
    format!("repos/{}/{path}", crate::REPOSITORY)
}
fn runs_endpoint() -> String {
    endpoint(&format!(
        "actions/workflows/checks.yml/runs?event=pull_request&head_sha={}&per_page=5",
        context().head
    ))
}
fn main_endpoint() -> String {
    endpoint(&format!(
        "actions/workflows/checks.yml/runs?branch=main&event=push&head_sha={}&per_page=5",
        context().head
    ))
}
fn main_run() -> Value {
    let mut run = run_record();
    run["id"] = 9.into();
    run["event"] = "push".into();
    run["head_branch"] = "main".into();
    run
}
fn queue_endpoint() -> String {
    endpoint(&format!(
        "actions/workflows/checks.yml/runs?event=merge_group&head_sha={}&per_page=5",
        context().commit
    ))
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
            let c = context();
            return Ok(match args[1] {
                "rev-list" => format!("{} {} {}", c.commit, c.base, c.head).into_bytes(),
                "rev-parse" => c.tree.into_bytes(),
                "diff" => b"backend/src/main.rs\0".to_vec(),
                _ => panic!("Unexpected git"),
            });
        }
        if args[0] == "gh" {
            if let Some(bytes) = self.bytes.borrow().get(args[2]) {
                if let Some(output) = output {
                    fs::write(output, bytes)?;
                    return Ok(vec![]);
                }
                return Ok(bytes.clone());
            }
            let mut replies = self.json.borrow_mut();
            let queue = replies.get_mut(args[2]).ok_or("API unavailable")?;
            let value = if queue.len() > 1 {
                queue.pop_front().unwrap()
            } else {
                queue.front().ok_or("No reply")?.clone()
            };
            return Ok(serde_json::to_vec(&value)?);
        }
        Native.command(args, cwd, timeout, output)
    }
    fn request(&self, _url: &str, _head: bool, _follow: bool, _timeout: u64) -> Result<Response> {
        panic!("No HTTP expected")
    }
}
fn zip(name: &str, bytes: &[u8]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
    zip.start_file(name, zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(bytes).unwrap();
    zip.finish().unwrap().into_inner()
}
struct Fixture {
    temp: tempfile::TempDir,
    system: Fake,
    receipt: Value,
    record: Value,
    archive: Vec<u8>,
    env: Environment,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("tooling/ci")).unwrap();
        fs::write(
            root.join("tooling/ci/test-plan.json"),
            r#"{"dashboard":[]}"#,
        )
        .unwrap();
        let source = root.join("source");
        for dir in ["dashboard", "services/rust", "tooling"] {
            fs::create_dir_all(source.join(dir)).unwrap();
        }
        fs::write(source.join("dashboard/index.html"), "tested dashboard").unwrap();
        fs::write(
            source.join("services/rust/dispatch-backend"),
            "tested backend",
        )
        .unwrap();
        let old = "e".repeat(40);
        fs::write(
            source.join("tooling/build-info.json"),
            json!({"commit":old,"hostManagement":1}).to_string(),
        )
        .unwrap();
        artifact::write_manifest(&source, "0.1.0").unwrap();
        let tar = flate2::write::GzEncoder::new(vec![], flate2::Compression::default());
        let mut tar = tar::Builder::new(tar);
        tar.append_dir_all(".", &source).unwrap();
        let packed = tar.into_inner().unwrap().finish().unwrap();
        let archive = zip("dispatch-dev.tar.gz", &packed);
        let c = context();
        let receipt = json!({"format":1,"repository":crate::REPOSITORY,"workflow":WORKFLOW,"baseRef":"dev","runId":5,"attempt":1,"scope":"full","commit":old,"base":c.base,"head":c.head,"tree":c.tree});
        let record = json!({"name":"dispatch-pr-build-5-1","id":42,"expired":false,"size_in_bytes":archive.len(),"digest":format!("sha256:{}",artifact::hash(&archive))});
        let env = Environment(
            [
                ("GITHUB_EVENT_NAME", "push".into()),
                ("GITHUB_REF", "refs/heads/dev".into()),
                ("GITHUB_SHA", c.commit),
            ]
            .into_iter()
            .map(|(k, v)| (k.into(), v))
            .collect(),
        );
        let fixture = Self {
            temp,
            system: Fake::default(),
            receipt,
            record,
            archive,
            env,
        };
        fixture.refresh();
        fixture
    }
    fn root(&self) -> &Path {
        self.temp.path()
    }
    fn destination(&self) -> PathBuf {
        self.root().join(".build")
    }
    fn refresh(&self) {
        let validation = zip(
            "validation.json",
            &serde_json::to_vec(&self.receipt).unwrap(),
        );
        self.system
            .json
            .borrow_mut()
            .insert(queue_endpoint(), vec![json!({"workflow_runs":[]})].into());
        self.system.json.borrow_mut().insert(
            runs_endpoint(),
            vec![json!({"workflow_runs":[run_record()]})].into(),
        );
        self.system.json.borrow_mut().insert(endpoint("actions/runs/5/artifacts"),vec![json!({"artifacts":[{"name":"dispatch-validation-5-1","id":7,"expired":false,"size_in_bytes":validation.len(),"digest":format!("sha256:{}",artifact::hash(&validation))},self.record]})].into());
        self.system
            .bytes
            .borrow_mut()
            .insert(endpoint("actions/artifacts/7/zip"), validation);
        self.system
            .bytes
            .borrow_mut()
            .insert(endpoint("actions/artifacts/42/zip"), self.archive.clone());
    }
    /// A PR into dev whose head is main's published commit: main's push run and its
    /// branch build, built from that head, replace the PR receipt and gated build.
    fn via_main(&mut self) {
        let source = self.root().join("source");
        fs::write(
            source.join("tooling/build-info.json"),
            json!({"commit":context().head,"hostManagement":1}).to_string(),
        )
        .unwrap();
        artifact::write_manifest(&source, "0.1.0").unwrap();
        let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
            vec![],
            flate2::Compression::default(),
        ));
        tar.append_dir_all(".", &source).unwrap();
        self.archive = zip(
            "dispatch-dev.tar.gz",
            &tar.into_inner().unwrap().finish().unwrap(),
        );
        self.record = json!({"name":format!("dispatch-main-{}",context().head),"id":43,"expired":false,"size_in_bytes":self.archive.len(),"digest":format!("sha256:{}",artifact::hash(&self.archive))});
        self.env
            .0
            .insert("GITHUB_EVENT_NAME".into(), "pull_request".into());
        self.env
            .0
            .insert("GITHUB_REF".into(), "refs/pull/1/merge".into());
        self.env.0.insert("GITHUB_BASE_REF".into(), "dev".into());
        self.refresh();
        self.system.json.borrow_mut().insert(
            main_endpoint(),
            vec![json!({"workflow_runs":[main_run()]})].into(),
        );
        self.system.json.borrow_mut().insert(
            endpoint("actions/runs/9/artifacts"),
            vec![json!({"artifacts":[self.record]})].into(),
        );
        self.system
            .bytes
            .borrow_mut()
            .insert(endpoint("actions/artifacts/43/zip"), self.archive.clone());
    }
    fn reuse(&self) -> Result<bool> {
        reuse(&self.system, self.root(), &self.env, &self.destination())
    }
    fn restore(&self) -> Result<()> {
        let runner = Runner(&self.system);
        restore(
            &self.system,
            &Policy {
                root: self.root(),
                runner: &runner,
            },
            &self.env,
            &self.destination(),
        )
    }
}
#[test]
fn promotes_only_metadata_and_preserves_every_tested_application_byte() {
    let f = Fixture::new();
    assert!(f.reuse().unwrap());
    let root = f.destination();
    let manifest = artifact::verify(&root, Some(&context().commit)).unwrap();
    assert_eq!(manifest.version, "0.1.0");
    assert_eq!(
        fs::read(root.join("dashboard/index.html")).unwrap(),
        b"tested dashboard"
    );
    assert_eq!(
        fs::read(root.join("services/rust/dispatch-backend")).unwrap(),
        b"tested backend"
    );
    assert_eq!(
        root.join("services/rust/dispatch-backend")
            .metadata()
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_ne!(
        manifest.digest,
        artifact::verify(&f.root().join("source"), None)
            .unwrap()
            .digest
    );
    assert!(!fs::read_dir(f.root()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("dispatch-pr-build-")
    }));
}
#[test]
fn missing_expired_wrong_attempt_or_corrupt_artifacts_fall_back_only_with_current_validation() {
    for problem in [
        "name",
        "expired",
        "digest",
        "size",
        "zero",
        "missing",
        "commit",
        "inventory",
    ] {
        let mut f = Fixture::new();
        match problem {
            "name" => f.record["name"] = "dispatch-pr-build-5-2".into(),
            "expired" => f.record["expired"] = true.into(),
            "digest" => f.record["digest"] = "sha256:bad".into(),
            "size" => f.record["size_in_bytes"] = 1.into(),
            "zero" => f.record["size_in_bytes"] = 0.into(),
            "commit" => f.receipt["commit"] = "f".repeat(40).into(),
            "inventory" => {
                let source = f.root().join("source");
                fs::write(source.join("dashboard/index.html"), "tampered").unwrap();
                let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
                    vec![],
                    flate2::Compression::default(),
                ));
                tar.append_dir_all(".", source).unwrap();
                f.archive = zip(
                    "dispatch-dev.tar.gz",
                    &tar.into_inner().unwrap().finish().unwrap(),
                );
                f.record["size_in_bytes"] = f.archive.len().into();
                f.record["digest"] = format!("sha256:{}", artifact::hash(&f.archive)).into();
            }
            "missing" => {}
            _ => unreachable!(),
        }
        f.refresh();
        if problem == "missing" {
            f.system
                .bytes
                .borrow_mut()
                .remove(&endpoint("actions/artifacts/42/zip"));
        }
        assert!(!f.reuse().unwrap(), "{problem}");
        assert!(!f.destination().exists());
    }
}
#[test]
fn revoked_validation_never_falls_back_even_when_the_artifact_is_unavailable() {
    for phase in ["before", "during", "missing"] {
        for state in ["failure", "pending", "skipped"] {
            let mut f = Fixture::new();
            if phase == "missing" {
                f.record["expired"] = true.into();
                f.refresh();
            }
            let mut newer = run_record();
            newer["run_attempt"] = 2.into();
            newer["conclusion"] = state.into();
            if state == "pending" {
                newer["status"] = "in_progress".into();
                newer["conclusion"] = Value::Null;
            }
            let bad = json!({"workflow_runs":[run_record(),newer]});
            let queue = if phase == "before" {
                vec![bad]
            } else {
                vec![json!({"workflow_runs":[run_record()]}), bad]
            };
            f.system
                .json
                .borrow_mut()
                .insert(runs_endpoint(), queue.into());
            assert!(
                f.reuse().unwrap_err().is::<ValidationChanged>(),
                "{phase}/{state}"
            );
            assert!(!f.destination().exists());
        }
    }
    let f = Fixture::new();
    f.system.json.borrow_mut().remove(&runs_endpoint());
    assert!(f.reuse().unwrap_err().is::<ValidationChanged>());
}
#[test]
fn validation_change_to_a_new_green_run_also_prevents_promotion() {
    let f = Fixture::new();
    let mut newer = run_record();
    newer["id"] = 6.into();
    f.system.json.borrow_mut().insert(
        runs_endpoint(),
        vec![
            json!({"workflow_runs":[run_record()]}),
            json!({"workflow_runs":[newer]}),
        ]
        .into(),
    );
    assert!(f.reuse().unwrap_err().is::<ValidationChanged>());
    assert!(!f.destination().exists());
}
#[test]
fn only_trusted_pushes_with_the_actual_source_and_matching_base_can_reuse() {
    for (key, value) in [
        ("GITHUB_EVENT_NAME", "pull_request"),
        ("GITHUB_REF", "refs/heads/feature/test"),
        ("GITHUB_SHA", "wrong"),
    ] {
        let mut f = Fixture::new();
        f.env.0.insert(key.into(), value.into());
        assert!(f.reuse().unwrap_err().is::<ValidationChanged>());
    }
    let mut f = Fixture::new();
    f.env
        .0
        .insert("GITHUB_REF".into(), "refs/heads/main".into());
    assert!(f.reuse().unwrap_err().is::<ValidationChanged>());
    f.receipt["baseRef"] = "main".into();
    f.refresh();
    assert!(f.reuse().unwrap());
}
#[test]
fn a_pr_bringing_mains_published_commit_reuses_that_build_for_its_own_merge() {
    let mut f = Fixture::new();
    f.via_main();
    assert!(f.reuse().unwrap());
    let root = f.destination();
    let manifest = artifact::verify(&root, Some(&context().commit)).unwrap();
    assert_eq!(manifest.version, "0.1.0");
    assert_eq!(
        fs::read(root.join("dashboard/index.html")).unwrap(),
        b"tested dashboard"
    );
    assert_eq!(
        root.join("services/rust/dispatch-backend")
            .metadata()
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert!(!fs::read_dir(f.root()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("dispatch-main-build-")
    }));
    // An unavailable or foreign build falls back to compilation while main's validation holds.
    for problem in ["expired", "name", "digest", "commit"] {
        let mut f = Fixture::new();
        f.via_main();
        match problem {
            "expired" => f.record["expired"] = true.into(),
            "name" => f.record["name"] = "dispatch-dev-other".into(),
            "digest" => f.record["digest"] = "sha256:bad".into(),
            "commit" => {
                f.env
                    .0
                    .insert("GITHUB_SHA".into(), context().commit.clone());
                let source = f.root().join("source");
                fs::write(
                    source.join("tooling/build-info.json"),
                    json!({"commit":"f".repeat(40),"hostManagement":1}).to_string(),
                )
                .unwrap();
                artifact::write_manifest(&source, "0.1.0").unwrap();
                let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
                    vec![],
                    flate2::Compression::default(),
                ));
                tar.append_dir_all(".", source).unwrap();
                f.archive = zip(
                    "dispatch-dev.tar.gz",
                    &tar.into_inner().unwrap().finish().unwrap(),
                );
                f.record["size_in_bytes"] = f.archive.len().into();
                f.record["digest"] = format!("sha256:{}", artifact::hash(&f.archive)).into();
                f.system
                    .bytes
                    .borrow_mut()
                    .insert(endpoint("actions/artifacts/43/zip"), f.archive.clone());
            }
            _ => unreachable!(),
        }
        f.system.json.borrow_mut().insert(
            endpoint("actions/runs/9/artifacts"),
            vec![json!({"artifacts":[f.record]})].into(),
        );
        assert!(!f.reuse().unwrap(), "{problem}");
        assert!(!f.destination().exists(), "{problem}");
    }
    // Without main's passed run of the head, or into another base, nothing is reused or built.
    for state in ["failure", "pending", "missing", "during"] {
        let mut f = Fixture::new();
        f.via_main();
        let mut bad = main_run();
        bad["conclusion"] = state.into();
        if state == "pending" {
            bad["status"] = "in_progress".into();
            bad["conclusion"] = Value::Null;
        }
        let queue = match state {
            "missing" => vec![json!({"workflow_runs":[]})],
            "during" => vec![
                json!({"workflow_runs":[main_run()]}),
                json!({"workflow_runs":[bad]}),
            ],
            _ => vec![json!({"workflow_runs":[bad]})],
        };
        f.system
            .json
            .borrow_mut()
            .insert(main_endpoint(), queue.into());
        assert!(f.reuse().unwrap_err().is::<ValidationChanged>(), "{state}");
        assert!(!f.destination().exists(), "{state}");
    }
    for (key, value) in [("GITHUB_BASE_REF", "main"), ("GITHUB_SHA", "wrong")] {
        let mut f = Fixture::new();
        f.via_main();
        f.env.0.insert(key.into(), value.into());
        assert!(f.reuse().unwrap_err().is::<ValidationChanged>(), "{key}");
    }
}
#[test]
fn existing_destination_and_symlink_are_never_replaced() {
    for link in [false, true] {
        let f = Fixture::new();
        let sentinel = f.root().join("sentinel");
        fs::create_dir(&sentinel).unwrap();
        fs::write(sentinel.join("keep"), "unchanged").unwrap();
        if link {
            symlink(&sentinel, f.destination()).unwrap();
        } else {
            fs::rename(&sentinel, f.destination()).unwrap();
        }
        assert!(f.restore().is_err());
        assert_eq!(
            fs::read_to_string(f.destination().join("keep")).unwrap(),
            "unchanged"
        );
    }
}
