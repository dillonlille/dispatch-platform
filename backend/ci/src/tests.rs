use super::*;
use policy::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
};

fn context() -> Context {
    Context {
        commit: "a".repeat(40),
        base: "b".repeat(40),
        head: "c".repeat(40),
        tree: "d".repeat(40),
    }
}
fn run() -> Value {
    json!({"id":5,"run_attempt":1,"head_sha":context().head,"event":"pull_request","head_branch":"feature/test","status":"completed","conclusion":"success","path":WORKFLOW,"head_repository":{"full_name":REPOSITORY}})
}
fn queue_run() -> Value {
    let mut run = run();
    run["event"] = "merge_group".into();
    run["head_sha"] = context().commit.into();
    run["head_branch"] = "gh-readonly-queue/dev/pr-1-b".into();
    run
}
fn queue_endpoint() -> String {
    format!(
        "actions/workflows/checks.yml/runs?event=merge_group&head_sha={}&per_page=5",
        context().commit
    )
}
fn main_run() -> Value {
    let mut run = run();
    run["id"] = 9.into();
    run["event"] = "push".into();
    run["head_branch"] = "main".into();
    run
}
fn main_endpoint() -> String {
    format!(
        "actions/workflows/checks.yml/runs?branch=main&event=push&head_sha={}&per_page=5",
        context().head
    )
}
fn receipt() -> Value {
    let c = context();
    json!({"format":1,"repository":REPOSITORY,"workflow":WORKFLOW,"baseRef":"dev","runId":5,"attempt":1,"scope":"full","commit":c.commit,"base":c.base,"head":c.head,"tree":c.tree})
}
fn zip(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
    for (name, bytes) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}
#[derive(Default)]
struct Fake {
    replies: RefCell<BTreeMap<String, Vec<u8>>>,
    paths: RefCell<String>,
    /// The tree of the merge head's own commit; the merge's tree unless a test moves it.
    head_tree: RefCell<Option<String>>,
}
impl Runner for Fake {
    fn command(&self, args: &[&str], _cwd: Option<&Path>, timeout: u64) -> Result<Vec<u8>> {
        assert_eq!(timeout, 20);
        let c = context();
        if args[0] == "git" {
            return Ok(match args[1] {
                "rev-list" => format!("{} {} {}\n", c.commit, c.base, c.head).into_bytes(),
                "rev-parse" if args[2] == format!("{}^{{tree}}", c.head) => self
                    .head_tree
                    .borrow()
                    .clone()
                    .unwrap_or(c.tree)
                    .into_bytes(),
                "rev-parse" => c.tree.into_bytes(),
                "diff" => self.paths.borrow().as_bytes().to_vec(),
                _ => panic!("Unexpected git"),
            });
        }
        assert_eq!(&args[..2], ["gh", "api"]);
        self.replies
            .borrow()
            .get(args[2])
            .cloned()
            .ok_or("API unavailable".into())
    }
}
struct Fixture {
    temp: tempfile::TempDir,
    fake: Fake,
}
impl Fixture {
    fn new() -> Self {
        let result = Self {
            temp: tempfile::tempdir().unwrap(),
            fake: Fake::default(),
        };
        fs::create_dir_all(result.temp.path().join("tooling/ci")).unwrap();
        fs::write(
            result.temp.path().join("tooling/ci/test-plan.json"),
            r#"{"dashboard":["tests/dashboard/calendar.test.ts"]}"#,
        )
        .unwrap();
        result.fake.paths.replace("dashboard/src/app.ts\0".into());
        result.json(&queue_endpoint(), json!({"workflow_runs":[]}));
        result.json(&main_endpoint(), json!({"workflow_runs":[]}));
        result.json(
            &format!(
                "actions/workflows/checks.yml/runs?event=pull_request&head_sha={}&per_page=5",
                context().head
            ),
            json!({"workflow_runs":[run()]}),
        );
        result.set_receipt(receipt());
        result
    }
    fn json(&self, endpoint: &str, value: Value) {
        self.fake.replies.borrow_mut().insert(
            format!("repos/{REPOSITORY}/{endpoint}"),
            serde_json::to_vec(&value).unwrap(),
        );
    }
    fn set_receipt(&self, value: Value) {
        let archive = zip(&[("validation.json", serde_json::to_vec(&value).unwrap())]);
        self.json("actions/runs/5/artifacts",json!({"artifacts":[{"name":"dispatch-validation-5-1","id":7,"expired":false,"size_in_bytes":archive.len(),"digest":format!("sha256:{:x}",Sha256::digest(&archive))}]}));
        self.fake.replies.borrow_mut().insert(
            format!("repos/{REPOSITORY}/actions/artifacts/7/zip"),
            archive,
        );
    }
    fn policy(&self) -> Policy<'_> {
        Policy {
            root: self.temp.path(),
            runner: &self.fake,
        }
    }
}
fn environment(event: &str, reference: &str) -> Environment {
    Environment(
        [
            ("GITHUB_EVENT_NAME", event.to_owned()),
            ("GITHUB_REF", reference.to_owned()),
            ("GITHUB_SHA", context().commit),
            ("GITHUB_RUN_ID", "5".into()),
            ("GITHUB_RUN_ATTEMPT", "1".into()),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v))
        .collect(),
    )
}
fn event() -> Value {
    let c = context();
    json!({"before":c.base,"pull_request":{"draft":false,"base":{"ref":"dev","sha":c.base,"repo":{"full_name":REPOSITORY}},"head":{"sha":c.head,"repo":{"full_name":REPOSITORY}}}})
}
fn queue_event() -> Value {
    let c = context();
    json!({"merge_group":{"head_sha":c.commit,"base_sha":c.base,"base_ref":"refs/heads/dev","head_ref":"refs/heads/gh-readonly-queue/dev/pr-1-b"}})
}

#[test]
fn conservative_scope_tracks_the_actual_dashboard_test_plan() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let plan: Value =
        serde_json::from_slice(&fs::read(root.join("tooling/ci/test-plan.json")).unwrap()).unwrap();
    let tests: Vec<String> = serde_json::from_value(plan["dashboard"].clone()).unwrap();
    for path in tests.iter().map(String::as_str).chain([
        "dashboard/index.html",
        "dashboard/src/main.ts",
        "dashboard/public/icon.svg",
        "tests/browser/helper.ts",
        "docs/architecture.md",
        "README.md",
    ]) {
        assert_eq!(scope(&[path.into()], &tests), "dashboard", "{path}");
    }
    for path in [
        "backend/README.md",
        "shared/contracts.ts",
        "tooling/ci/test-plan.json",
        "package-lock.json",
        "tests/dashboard/unknown.test.ts",
        "tests/browser/helper.json",
        "dashboard/vite.config.ts",
        "AGENTS.json",
        "",
    ] {
        assert_eq!(
            scope(&["dashboard/src/main.ts".into(), path.into()], &tests),
            "full",
            "{path}"
        );
    }
    assert_eq!(scope(&[], &tests), "full");
}
#[test]
fn receipts_bind_repository_workflow_run_attempt_parents_tree_scope_and_source() {
    let good = receipt();
    assert!(matches(&good, &run(), &context(), "dashboard", "dev"));
    for (key, value) in [
        ("format", json!(2)),
        ("repository", json!("fork/repo")),
        ("workflow", json!("other.yml")),
        ("baseRef", json!("main")),
        ("runId", json!(6)),
        ("attempt", json!(2)),
        ("base", json!("e".repeat(40))),
        ("head", json!("e".repeat(40))),
        ("tree", json!("e".repeat(40))),
        ("scope", json!("reuse")),
        ("commit", json!("invalid")),
    ] {
        let mut changed = good.clone();
        changed[key] = value;
        assert!(
            !matches(&changed, &run(), &context(), "dashboard", "dev"),
            "{key}"
        );
        changed.as_object_mut().unwrap().remove(key);
        assert!(
            !matches(&changed, &run(), &context(), "dashboard", "dev"),
            "missing {key}"
        );
    }
    let mut narrow = good.clone();
    narrow["scope"] = "dashboard".into();
    assert!(!matches(&narrow, &run(), &context(), "full", "dev"));
    assert!(matches(&narrow, &run(), &context(), "dashboard", "dev"));
    let mut prior_synthetic_merge = good;
    prior_synthetic_merge["commit"] = "e".repeat(40).into();
    assert!(matches(
        &prior_synthetic_merge,
        &run(),
        &context(),
        "full",
        "dev"
    ));
}
#[test]
fn archive_integrity_entry_count_names_and_expansion_are_bounded() {
    let good = zip(&[("validation.json", serde_json::to_vec(&receipt()).unwrap())]);
    let digest = format!("sha256:{:x}", Sha256::digest(&good));
    assert_eq!(read_receipt(&good, &digest).unwrap(), receipt());
    assert!(read_receipt(&good, "sha256:wrong").is_err());
    for entries in [
        vec![("other.json", b"{}".to_vec())],
        vec![("validation.json", b"[]".to_vec())],
        vec![("validation.json", vec![b' '; 16_001])],
        vec![("validation.json", b"{}".to_vec()), ("extra", vec![])],
    ] {
        let bytes = zip(&entries);
        assert!(read_receipt(&bytes, &format!("sha256:{:x}", Sha256::digest(&bytes))).is_err());
    }
    let bytes = vec![0; 100_001];
    assert!(read_receipt(&bytes, &format!("sha256:{:x}", Sha256::digest(&bytes))).is_err());
    assert!(
        read_receipt(
            b"not zip",
            &format!("sha256:{:x}", Sha256::digest(b"not zip"))
        )
        .is_err()
    );
}
#[test]
fn latest_run_never_revives_older_validation() {
    let good = run();
    let sha = context().head;
    for change in [
        json!({"conclusion":"failure"}),
        json!({"status":"in_progress","conclusion":null}),
        json!({"conclusion":"skipped"}),
    ] {
        let mut latest = good.clone();
        latest["id"] = 6.into();
        latest
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        let all = json!([good, latest]);
        let chosen = runs::latest_run(&all, &sha, "pull_request", None, true).unwrap();
        assert_eq!(chosen["id"], 6);
        assert!(!trusted_run(chosen, &sha));
    }
    let mut rerun = good.clone();
    rerun["run_attempt"] = 2.into();
    rerun["conclusion"] = "failure".into();
    let all = json!([rerun, good]);
    assert_eq!(
        runs::latest_run(&all, &sha, "pull_request", None, true).unwrap()["run_attempt"],
        2
    );
    for (key, value) in [
        ("head_sha", json!("other")),
        ("event", json!("push")),
        ("head_branch", json!("other")),
        ("head_repository", json!({"full_name":"fork/repo"})),
    ] {
        let mut other = good.clone();
        other["id"] = 9.into();
        other[key] = value;
        let all = json!([other, good]);
        assert_eq!(
            runs::latest_run(&all, &sha, "pull_request", Some("feature/test"), true).unwrap()["id"],
            5
        );
    }
    let mut skipped = good.clone();
    skipped["id"] = 6.into();
    skipped["conclusion"] = "skipped".into();
    let all = json!([good, skipped]);
    assert_eq!(
        runs::latest_run(&all, &sha, "pull_request", None, false).unwrap()["id"],
        5
    );
    for (key, value) in [
        ("path", json!("other.yml")),
        ("head_repository", Value::Null),
        ("status", json!("queued")),
        ("event", json!("push")),
    ] {
        let mut invalid = run();
        invalid[key] = value;
        assert!(!trusted_run(&invalid, &sha));
    }
}
#[test]
fn planner_reuses_only_current_validated_merges_and_defaults_conservatively() {
    let fixture = Fixture::new();
    let env = environment("push", "refs/heads/dev");
    assert_eq!(fixture.policy().plan(&env, &event()).0, "reuse");
    for change in [
        json!({"conclusion":"failure"}),
        json!({"status":"in_progress"}),
        json!({"conclusion":"skipped"}),
        json!({"path":"other.yml"}),
    ] {
        let mut newer = run();
        newer["id"] = 6.into();
        newer
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        fixture.json(
            &format!(
                "actions/workflows/checks.yml/runs?event=pull_request&head_sha={}&per_page=5",
                context().head
            ),
            json!({"workflow_runs":[run(),newer]}),
        );
        assert_eq!(fixture.policy().plan(&env, &event()).0, "dashboard");
    }
    fixture.fake.replies.borrow_mut().clear();
    assert_eq!(fixture.policy().plan(&env, &event()).0, "dashboard");
    // A merge queue run of the pushed commit itself is reused, and its newest run decides
    // even when the PR head's own run passed.
    let queued = Fixture::new();
    queued.json(&queue_endpoint(), json!({"workflow_runs":[queue_run()]}));
    assert_eq!(queued.policy().plan(&env, &event()).0, "reuse");
    queued.json(
        &format!(
            "actions/workflows/checks.yml/runs?event=pull_request&head_sha={}&per_page=5",
            context().head
        ),
        json!({"workflow_runs":[]}),
    );
    assert_eq!(queued.policy().plan(&env, &event()).0, "reuse");
    for change in [
        json!({"conclusion":"failure"}),
        json!({"status":"in_progress"}),
        json!({"conclusion":"skipped"}),
    ] {
        let mut newer = queue_run();
        newer["id"] = 6.into();
        newer
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        let blocked = Fixture::new();
        blocked.json(
            &queue_endpoint(),
            json!({"workflow_runs":[queue_run(),newer]}),
        );
        assert_eq!(blocked.policy().plan(&env, &event()).0, "dashboard");
    }
    // Merge queue runs scope every PR in the group against the group's base.
    let group = environment("merge_group", "refs/heads/gh-readonly-queue/dev/pr-1-b");
    assert_eq!(fixture.policy().plan(&group, &queue_event()).0, "dashboard");
    fixture.fake.paths.replace("backend/src/lib.rs\0".into());
    assert_eq!(fixture.policy().plan(&group, &queue_event()).0, "full");
    fixture.fake.paths.replace("dashboard/src/app.ts\0".into());
    let mut main_group = queue_event();
    main_group["merge_group"]["base_ref"] = "refs/heads/main".into();
    assert_eq!(fixture.policy().plan(&group, &main_group).0, "full");
    assert_eq!(
        fixture
            .policy()
            .plan(&environment("push", "refs/heads/main"), &event())
            .0,
        "full"
    );
    for name in ["workflow_dispatch", "schedule", "release"] {
        assert_eq!(
            fixture
                .policy()
                .plan(&environment(name, "refs/heads/dev"), &event())
                .0,
            "full"
        );
    }
    assert_eq!(
        fixture
            .policy()
            .plan(&environment("push", "refs/heads/other"), &event())
            .0,
        "full"
    );
    let mut pr = event();
    pr["pull_request"]["base"]["ref"] = "main".into();
    assert_eq!(
        fixture
            .policy()
            .plan(&environment("pull_request", "refs/pull/1/merge"), &pr)
            .0,
        "full"
    );
    pr["pull_request"]["draft"] = true.into();
    assert_eq!(
        fixture
            .policy()
            .plan(&environment("pull_request", "refs/pull/1/merge"), &pr)
            .0,
        "draft"
    );
    fixture.fake.paths.replace("backend/src/lib.rs\0".into());
    assert_eq!(fixture.policy().plan(&env, &event()).0, "full");
}
#[test]
fn receipt_artifact_must_be_unique_unexpired_and_match_its_github_record() {
    for invalid in [
        "expired",
        "duplicate",
        "oversized",
        "zero",
        "digest",
        "size",
        "attempt",
    ] {
        let f = Fixture::new();
        let endpoint = format!("repos/{REPOSITORY}/actions/runs/5/artifacts");
        let mut value: Value = serde_json::from_slice(&f.fake.replies.borrow()[&endpoint]).unwrap();
        match invalid {
            "expired" => value["artifacts"][0]["expired"] = true.into(),
            "duplicate" => {
                let record = value["artifacts"][0].clone();
                value["artifacts"].as_array_mut().unwrap().push(record);
            }
            "oversized" => value["artifacts"][0]["size_in_bytes"] = 100_001.into(),
            "zero" => value["artifacts"][0]["size_in_bytes"] = 0.into(),
            "digest" => value["artifacts"][0]["digest"] = "sha256:wrong".into(),
            "size" => value["artifacts"][0]["size_in_bytes"] = 1.into(),
            "attempt" => value["artifacts"][0]["name"] = "dispatch-validation-5-2".into(),
            _ => unreachable!(),
        }
        f.fake
            .replies
            .borrow_mut()
            .insert(endpoint, serde_json::to_vec(&value).unwrap());
        assert!(
            !matches!(f.policy().validated(&context(), "dev"), Ok(Some(_))),
            "{invalid}"
        );
    }
    let f = Fixture::new();
    assert!(f.policy().validated(&context(), "main").unwrap().is_none());
    let mut value = receipt();
    value["baseRef"] = "main".into();
    f.set_receipt(value.clone());
    assert!(f.policy().validated(&context(), "main").unwrap().is_some());
    value["scope"] = "dashboard".into();
    f.set_receipt(value);
    assert!(f.policy().validated(&context(), "main").unwrap().is_none());
}
#[test]
fn issuing_receipts_requires_actual_merge_trusted_pr_and_sufficient_checks() {
    let f = Fixture::new();
    let mut env = environment("pull_request", "refs/pull/1/merge");
    let good = event();
    assert_eq!(f.policy().receipt(&env, &good, "full").unwrap(), receipt());
    assert!(f.policy().receipt(&env, &good, "dashboard").is_ok());
    env.0.insert("CI_RUST_KEY".into(), "e".repeat(64));
    assert_eq!(
        f.policy().receipt(&env, &good, "full").unwrap()["rustKey"],
        "e".repeat(64)
    );
    env.0.insert("CI_RUST_KEY".into(), "invalid".into());
    assert!(
        f.policy()
            .receipt(&env, &good, "full")
            .unwrap()
            .get("rustKey")
            .is_none()
    );
    for pointer in [
        "/pull_request/base/sha",
        "/pull_request/head/sha",
        "/pull_request/base/repo/full_name",
        "/pull_request/head/repo/full_name",
        "/pull_request/base/ref",
    ] {
        let mut wrong = good.clone();
        *wrong.pointer_mut(pointer).unwrap() = "other".into();
        assert!(
            f.policy().receipt(&env, &wrong, "full").is_err(),
            "{pointer}"
        );
    }
    let mut wrong = good.clone();
    wrong["pull_request"]["draft"] = true.into();
    assert!(f.policy().receipt(&env, &wrong, "full").is_err());
    wrong = good.clone();
    wrong["pull_request"]["base"]["ref"] = "main".into();
    assert!(f.policy().receipt(&env, &wrong, "dashboard").is_err());
    assert!(f.policy().receipt(&env, &wrong, "full").is_ok());
    f.fake.paths.replace("backend/src/lib.rs\0".into());
    assert!(f.policy().receipt(&env, &good, "dashboard").is_err());
    for (key, value) in [
        ("GITHUB_SHA", "other"),
        ("GITHUB_EVENT_NAME", "push"),
        ("GITHUB_RUN_ID", "0"),
        ("GITHUB_RUN_ATTEMPT", "0"),
    ] {
        let mut env = environment("pull_request", "refs/pull/1/merge");
        env.0.insert(key.into(), value.into());
        assert!(f.policy().receipt(&env, &good, "full").is_err(), "{key}");
    }
    // A merge queue group binds the exact merge commit the queue pushes.
    f.fake.paths.replace("dashboard/src/app.ts\0".into());
    let env = environment("merge_group", "refs/heads/gh-readonly-queue/dev/pr-1-b");
    let group = queue_event();
    assert_eq!(f.policy().receipt(&env, &group, "full").unwrap(), receipt());
    assert!(f.policy().receipt(&env, &group, "dashboard").is_ok());
    f.fake.paths.replace("backend/src/lib.rs\0".into());
    assert!(f.policy().receipt(&env, &group, "dashboard").is_err());
    assert!(f.policy().receipt(&env, &group, "full").is_ok());
    f.fake.paths.replace("dashboard/src/app.ts\0".into());
    for (pointer, value) in [
        ("/merge_group/head_sha", "other"),
        ("/merge_group/base_sha", "other"),
        ("/merge_group/base_ref", "refs/heads/feature"),
    ] {
        let mut wrong = group.clone();
        *wrong.pointer_mut(pointer).unwrap() = value.into();
        assert!(
            f.policy().receipt(&env, &wrong, "full").is_err(),
            "{pointer}"
        );
    }
    let mut wrong = group.clone();
    wrong["merge_group"]["base_ref"] = "refs/heads/main".into();
    assert!(f.policy().receipt(&env, &wrong, "dashboard").is_err());
    assert!(f.policy().receipt(&env, &wrong, "full").is_ok());
    assert!(
        f.policy().receipt(&env, &good, "full").is_err(),
        "a PR payload is not a group"
    );
    let mut env = env;
    env.0.insert("GITHUB_SHA".into(), "other".into());
    assert!(f.policy().receipt(&env, &group, "full").is_err());
}
#[test]
fn prs_bringing_mains_verified_commit_reuse_its_published_build() {
    let f = Fixture::new();
    let env = environment("pull_request", "refs/pull/1/merge");
    assert_eq!(f.policy().plan(&env, &event()).0, "dashboard");
    f.json(&main_endpoint(), json!({"workflow_runs":[main_run()]}));
    assert_eq!(f.policy().plan(&env, &event()).0, "reuse");
    assert_eq!(
        f.policy().promoted_main(&context().head).unwrap().unwrap()["id"],
        9
    );
    // The receipt records the full validation main recorded, never reuse itself.
    assert_eq!(
        f.policy().receipt(&env, &event(), "reuse").unwrap(),
        receipt()
    );
    let mut fork = event();
    fork["pull_request"]["head"]["repo"]["full_name"] = "other/fork".into();
    assert_eq!(f.policy().plan(&env, &fork).0, "dashboard");
    let mut draft = event();
    draft["pull_request"]["draft"] = true.into();
    assert_eq!(f.policy().plan(&env, &draft).0, "draft");
    let mut release = event();
    release["pull_request"]["base"]["ref"] = "main".into();
    assert_eq!(f.policy().plan(&env, &release).0, "full");
    assert!(f.policy().receipt(&env, &release, "reuse").is_err());
    for change in [
        json!({"conclusion":"failure"}),
        json!({"status":"in_progress"}),
        json!({"event":"pull_request"}),
        json!({"head_branch":"dev"}),
        json!({"path":"other.yml"}),
        json!({"head_repository":{"full_name":"other/fork"}}),
    ] {
        let mut run = main_run();
        run.as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        f.json(&main_endpoint(), json!({"workflow_runs":[run]}));
        assert_eq!(f.policy().plan(&env, &event()).0, "dashboard", "{change}");
        assert!(
            f.policy().receipt(&env, &event(), "reuse").is_err(),
            "{change}"
        );
        assert!(f.policy().receipt(&env, &event(), "dashboard").is_ok());
    }
    assert!(f.policy().promoted_main("main").unwrap().is_none());
    // The merge must change nothing against main: a merge that also carries other dev
    // commits has another tree and gets ordinary checks, as PR and as merge queue group.
    f.json(&main_endpoint(), json!({"workflow_runs":[main_run()]}));
    let group = environment("merge_group", "refs/heads/gh-readonly-queue/dev/pr-1-b");
    assert_eq!(f.policy().plan(&group, &queue_event()).0, "reuse");
    assert_eq!(
        f.policy().receipt(&group, &queue_event(), "reuse").unwrap(),
        receipt()
    );
    let mut batched = queue_event();
    batched["merge_group"]["base_sha"] = "e".repeat(40).into();
    assert_eq!(f.policy().plan(&group, &batched).0, "dashboard");
    let mut other = queue_event();
    other["merge_group"]["head_sha"] = "e".repeat(40).into();
    assert_eq!(f.policy().plan(&group, &other).0, "dashboard");
    f.fake.head_tree.replace(Some("e".repeat(40)));
    assert!(f.policy().brings_main(&context()).unwrap().is_none());
    assert_eq!(f.policy().plan(&env, &event()).0, "dashboard");
    assert_eq!(f.policy().plan(&group, &queue_event()).0, "dashboard");
    assert!(f.policy().receipt(&env, &event(), "reuse").is_err());
    assert!(f.policy().receipt(&group, &queue_event(), "reuse").is_err());
    assert!(f.policy().receipt(&env, &event(), "dashboard").is_ok());
}
#[test]
fn gate_requires_every_expected_job_in_every_mode() {
    for mode in ["full", "dashboard", "reuse"] {
        let mut needs = json!({"plan":{"result":"success","outputs":{"mode":mode}},"build":{"result":"success"},"browser":{"result":if mode=="reuse"{"skipped"}else{"success"}},"rust-advisories":{"result":"success"},"core":{"result":if mode=="full"{"success"}else{"skipped"}},"collectors":{"result":if mode=="full"{"success"}else{"skipped"}}});
        assert_eq!(gate(&needs).unwrap(), mode);
        for job in [
            "plan",
            "build",
            "browser",
            "rust-advisories",
            "core",
            "collectors",
        ] {
            let mut missing = needs.clone();
            missing.as_object_mut().unwrap().remove(job);
            assert!(gate(&missing).is_err());
            for result in ["success", "skipped", "failure", "cancelled", ""] {
                if needs[job]["result"] == result {
                    continue;
                }
                let mut wrong = needs.clone();
                wrong[job]["result"] = result.into();
                assert!(gate(&wrong).is_err(), "{mode}/{job}/{result}");
            }
        }
        for mode in ["unknown", "draft", ""] {
            needs["plan"]["outputs"]["mode"] = mode.into();
            assert!(gate(&needs).is_err());
        }
    }
}
#[test]
fn real_git_merge_and_renames_keep_both_changed_paths() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let git = |args: &[&str]| {
        let mut command = vec![
            "git",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@dispatch.test",
        ];
        command.extend_from_slice(args);
        String::from_utf8(Native.command(&command, Some(root), 20).unwrap())
            .unwrap()
            .trim()
            .to_owned()
    };
    git(&["init", "-b", "dev"]);
    fs::create_dir(root.join("backend")).unwrap();
    fs::write(root.join("backend/doc.md"), "same content").unwrap();
    git(&["add", "."]);
    git(&["commit", "-m", "base"]);
    let base = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "-b", "feature/test"]);
    git(&["mv", "backend/doc.md", "README.md"]);
    git(&["commit", "-m", "rename"]);
    let head = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "dev"]);
    git(&["merge", "--no-ff", "feature/test", "-m", "merge"]);
    let policy = Policy {
        root,
        runner: &Native,
    };
    let context = policy.context().unwrap().unwrap();
    assert_eq!(context.base, base);
    assert_eq!(context.head, head);
    let paths = policy.changes(&base).unwrap();
    assert!(paths.contains(&"README.md".into()) && paths.contains(&"backend/doc.md".into()));
    assert_eq!(scope(&paths, &[]), "full");
    git(&["checkout", "--detach", &base]);
    assert!(policy.context().unwrap().is_none());
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
