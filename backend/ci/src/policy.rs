use crate::{REPOSITORY, Result, Runner, require, runs::latest_run};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Cursor, Read},
    path::Path,
};

pub const WORKFLOW: &str = ".github/workflows/checks.yml";
pub fn trusted_branch(reference: &str) -> Option<&'static str> {
    match reference {
        "refs/heads/dev" => Some("dev"),
        "refs/heads/main" => Some("main"),
        _ => None,
    }
}
pub fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Context {
    pub commit: String,
    pub base: String,
    pub head: String,
    pub tree: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Validation {
    pub run: Value,
    pub receipt: Value,
}
#[derive(Default)]
pub struct Environment(pub BTreeMap<String, String>);
impl Environment {
    pub fn current() -> Self {
        Self(
            [
                "GITHUB_EVENT_NAME",
                "GITHUB_REF",
                "GITHUB_SHA",
                "GITHUB_RUN_ID",
                "GITHUB_RUN_ATTEMPT",
                "CI_RUST_KEY",
            ]
            .into_iter()
            .filter_map(|key| std::env::var(key).ok().map(|value| (key.into(), value)))
            .collect(),
        )
    }
    pub fn get(&self, key: &str) -> &str {
        self.0.get(key).map(String::as_str).unwrap_or("")
    }
}

pub fn scope(paths: &[String], dashboard_tests: &[String]) -> &'static str {
    if !paths.is_empty()
        && paths.iter().all(|name| {
            name == "dashboard/index.html"
                || dashboard_tests.contains(name)
                || name.starts_with("dashboard/src/")
                || name.starts_with("dashboard/public/")
                || (name.starts_with("tests/browser/") && name.ends_with(".ts"))
                || (name.ends_with(".md") && !name.starts_with("backend/"))
        })
    {
        "dashboard"
    } else {
        "full"
    }
}
/// A passed run of this workflow for `sha`: a same-repository PR run of that head, or a
/// merge queue run of that exact merge commit.
pub fn trusted_run(run: &Value, sha: &str) -> bool {
    run["head_sha"] == sha
        && (run["event"] == "pull_request" || run["event"] == "merge_group")
        && crate::runs::passed(run)
        && run["path"] == WORKFLOW
        && run["head_repository"]["full_name"] == REPOSITORY
}
pub fn read_receipt(archive: &[u8], digest: &str) -> Result<Value> {
    require(
        archive.len() <= 100_000 && digest == format!("sha256:{:x}", Sha256::digest(archive)),
        "Validation archive digest mismatch",
    )?;
    let mut zip = zip::ZipArchive::new(Cursor::new(archive))?;
    require(zip.len() == 1, "Invalid validation archive")?;
    let entry = zip.by_index(0)?;
    require(
        entry.name() == "validation.json" && entry.size() <= 16_000,
        "Invalid validation archive",
    )?;
    let mut bytes = vec![];
    entry.take(16_001).read_to_end(&mut bytes)?;
    require(bytes.len() <= 16_000, "Validation receipt is too large")?;
    let receipt: Value = serde_json::from_slice(&bytes)?;
    require(receipt.is_object(), "Invalid validation receipt")?;
    Ok(receipt)
}
pub fn matches(
    receipt: &Value,
    run: &Value,
    context: &Context,
    expected: &str,
    base_ref: &str,
) -> bool {
    receipt["format"] == 1
        && receipt["repository"] == REPOSITORY
        && receipt["workflow"] == WORKFLOW
        && receipt["baseRef"] == base_ref
        && receipt["runId"].as_u64().is_some()
        && receipt["runId"] == run["id"]
        && receipt["attempt"].as_u64() == Some(run["run_attempt"].as_u64().unwrap_or(1))
        && receipt["base"] == context.base
        && receipt["head"] == context.head
        && receipt["tree"] == context.tree
        && receipt["commit"]
            .as_str()
            .is_some_and(|value| hex(value, 40))
        && (receipt["scope"] == "full" || receipt["scope"] == expected)
}
pub fn gate(needs: &Value) -> Result<&str> {
    let mode = needs["plan"]["outputs"]["mode"]
        .as_str()
        .ok_or("Missing validation plan")?;
    require(
        matches!(mode, "full" | "dashboard" | "reuse"),
        "Unknown validation plan",
    )?;
    for (job, result) in [
        ("plan", "success"),
        ("build", "success"),
        (
            "browser",
            if mode == "reuse" {
                "skipped"
            } else {
                "success"
            },
        ),
        ("rust-advisories", "success"),
        ("core", if mode == "full" { "success" } else { "skipped" }),
        (
            "collectors",
            if mode == "full" { "success" } else { "skipped" },
        ),
    ] {
        require(
            needs[job]["result"] == result,
            &format!("Required suite {job} did not report {result}"),
        )?;
    }
    Ok(mode)
}

pub struct Policy<'a> {
    pub root: &'a Path,
    pub runner: &'a dyn Runner,
}
impl Policy<'_> {
    pub fn git(&self, args: &[&str]) -> Result<String> {
        let mut command = vec!["git"];
        command.extend_from_slice(args);
        Ok(String::from_utf8(self.runner.command(
            &command,
            Some(self.root),
            20,
        )?)?)
    }
    pub fn changes(&self, base: &str) -> Result<Vec<String>> {
        let output = self.git(&["diff", "--no-renames", "--name-only", "-z", base, "HEAD"])?;
        require(
            output.is_empty() || output.ends_with('\0'),
            "Incomplete changed paths",
        )?;
        Ok(output.split_terminator('\0').map(str::to_owned).collect())
    }
    pub fn scope(&self, base: &str) -> Result<&'static str> {
        let plan: Value =
            serde_json::from_slice(&fs::read(self.root.join("tooling/ci/test-plan.json"))?)?;
        let tests: Vec<String> = serde_json::from_value(plan["dashboard"].clone())?;
        Ok(scope(&self.changes(base)?, &tests))
    }
    pub fn context(&self) -> Result<Option<Context>> {
        let output = self.git(&["rev-list", "--parents", "-n", "1", "HEAD"])?;
        let parts: Vec<_> = output.split_whitespace().collect();
        if parts.len() != 3 {
            return Ok(None);
        }
        let tree = self.git(&["rev-parse", "HEAD^{tree}"])?.trim().to_owned();
        require(
            parts.iter().all(|p| hex(p, 40)) && hex(&tree, 40),
            "Invalid merge context",
        )?;
        Ok(Some(Context {
            commit: parts[0].into(),
            base: parts[1].into(),
            head: parts[2].into(),
            tree,
        }))
    }
    pub fn github_bytes(&self, endpoint: &str) -> Result<Vec<u8>> {
        // The planner has a three-minute budget, including cold Rust compilation.
        self.runner.command(
            &["gh", "api", &format!("repos/{REPOSITORY}/{endpoint}")],
            Some(self.root),
            20,
        )
    }
    pub fn github(&self, endpoint: &str) -> Result<Value> {
        Ok(serde_json::from_slice(&self.github_bytes(endpoint)?)?)
    }
    pub fn validated(&self, context: &Context, base_ref: &str) -> Result<Option<Validation>> {
        require(matches!(base_ref, "dev" | "main"), "Untrusted base branch")?;
        // A merge queue tested this exact merge commit; its newest run decides, even when it
        // failed. Without one, the PR head's run counts for an identical merge.
        let queued = self.github(&format!(
            "actions/workflows/checks.yml/runs?event=merge_group&head_sha={}&per_page=5",
            context.commit
        ))?;
        let pulls;
        let (run, sha) = match latest_run(
            &queued["workflow_runs"],
            &context.commit,
            "merge_group",
            None,
            true,
        ) {
            Some(run) => (run, context.commit.as_str()),
            None => {
                pulls = self.github(&format!(
                    "actions/workflows/checks.yml/runs?event=pull_request&head_sha={}&per_page=5",
                    context.head
                ))?;
                let Some(run) = latest_run(
                    &pulls["workflow_runs"],
                    &context.head,
                    "pull_request",
                    None,
                    true,
                ) else {
                    return Ok(None);
                };
                (run, context.head.as_str())
            }
        };
        if !trusted_run(run, sha) {
            return Ok(None);
        }
        let id = run["id"].as_u64().ok_or("Invalid run id")?;
        let name = format!(
            "dispatch-validation-{id}-{}",
            run["run_attempt"].as_u64().unwrap_or(1)
        );
        let artifacts = self.github(&format!("actions/runs/{id}/artifacts"))?;
        let candidates: Vec<_> = artifacts["artifacts"]
            .as_array()
            .ok_or("Missing artifacts")?
            .iter()
            .filter(|a| a["name"] == name && a["expired"] == false)
            .collect();
        if candidates.len() != 1
            || !candidates[0]["size_in_bytes"]
                .as_u64()
                .is_some_and(|size| size > 0 && size <= 100_000)
        {
            return Ok(None);
        }
        let record = candidates[0];
        let id = record["id"].as_u64().ok_or("Invalid artifact id")?;
        let archive = self.github_bytes(&format!("actions/artifacts/{id}/zip"))?;
        require(
            record["size_in_bytes"].as_u64() == Some(archive.len() as u64),
            "Validation archive size mismatch",
        )?;
        let receipt = read_receipt(&archive, record["digest"].as_str().unwrap_or(""))?;
        let expected = if base_ref == "dev" {
            self.scope(&context.base)?
        } else {
            "full"
        };
        Ok(
            matches(&receipt, run, context, expected, base_ref).then(|| Validation {
                run: run.clone(),
                receipt,
            }),
        )
    }
    pub fn plan(&self, env: &Environment, event: &Value) -> (&'static str, String) {
        let name = env.get("GITHUB_EVENT_NAME");
        let reference = env.get("GITHUB_REF");
        if name == "pull_request" && event["pull_request"]["draft"] == true {
            return (
                "draft",
                "Draft PR: expensive checks start when marked ready for review".into(),
            );
        }
        let base = if name == "push" && trusted_branch(reference).is_some() {
            if let Ok(Some(context)) = self.context()
                && let Ok(Some(validation)) =
                    self.validated(&context, trusted_branch(reference).unwrap())
            {
                return (
                    "reuse",
                    format!(
                        "Identical base, head and source tree validated by PR run {}",
                        validation.run["id"]
                    ),
                );
            }
            if reference != "refs/heads/dev" {
                return (
                    "full",
                    "Full validation for a release without reusable PR validation".into(),
                );
            }
            event["before"].as_str()
        } else if name == "pull_request" && event["pull_request"]["base"]["ref"] == "dev" {
            event["pull_request"]["base"]["sha"].as_str()
        } else if name == "merge_group" && event["merge_group"]["base_ref"] == "refs/heads/dev" {
            // Every PR in the group is between the group's base and this merge commit.
            event["merge_group"]["base_sha"].as_str()
        } else {
            return (
                "full",
                "Full validation for release, manual or scheduled checks".into(),
            );
        };
        let selected = base
            .filter(|base| !base.is_empty())
            .and_then(|base| self.scope(base).ok())
            .unwrap_or("full");
        (
            selected,
            if selected == "dashboard" {
                "Dashboard, browser tests or documentation only"
            } else {
                "Backend, shared contracts, infrastructure or unknown changes"
            }
            .into(),
        )
    }
    pub fn receipt(&self, env: &Environment, event: &Value, selected: &str) -> Result<Value> {
        let context = self.context()?.ok_or("Actual PR merge required")?;
        let pr = &event["pull_request"];
        let group = &event["merge_group"];
        // A merge queue group is this repository's own merge of PRs whose checks passed; its
        // head is the exact commit the queue pushes, so it is bound instead of the PR parents.
        let queued = env.get("GITHUB_EVENT_NAME") == "merge_group";
        let base_ref = if queued {
            group["base_ref"]
                .as_str()
                .and_then(|reference| reference.strip_prefix("refs/heads/"))
                .unwrap_or("")
        } else {
            pr["base"]["ref"].as_str().unwrap_or("")
        };
        let source = if queued {
            group["head_sha"] == context.commit
                && group["base_sha"].as_str().is_some_and(|sha| hex(sha, 40))
        } else {
            env.get("GITHUB_EVENT_NAME") == "pull_request"
                && pr["draft"] == false
                && pr["base"]["repo"]["full_name"] == REPOSITORY
                && pr["head"]["repo"]["full_name"] == REPOSITORY
                && pr["base"]["sha"] == context.base
                && pr["head"]["sha"] == context.head
        };
        require(
            source
                && matches!(selected, "full" | "dashboard")
                && matches!(base_ref, "dev" | "main")
                && (base_ref == "dev" || selected == "full")
                && context.commit == env.get("GITHUB_SHA"),
            "Validation receipt requires the actual same-repository PR merge",
        )?;
        let changed_since = if queued {
            group["base_sha"].as_str().unwrap_or("")
        } else {
            &context.base
        };
        require(
            selected == "full" || selected == self.scope(changed_since)?,
            "Insufficient validation scope",
        )?;
        let run: u64 = env.get("GITHUB_RUN_ID").parse()?;
        let attempt: u64 = env.get("GITHUB_RUN_ATTEMPT").parse()?;
        require(
            run > 0 && attempt > 0,
            "Positive run id and attempt required",
        )?;
        let mut value = json!({"format":1, "repository":REPOSITORY, "workflow":WORKFLOW, "baseRef":base_ref,
            "runId":run, "attempt":attempt, "scope":selected, "commit":context.commit, "base":context.base, "head":context.head, "tree":context.tree});
        if hex(env.get("CI_RUST_KEY"), 64) {
            value["rustKey"] = env.get("CI_RUST_KEY").into();
        }
        Ok(value)
    }
}
