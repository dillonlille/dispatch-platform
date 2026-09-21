//! Release coordination. GitHub and immutable assets are the source of truth;
//! the small local journal only pins intent across process interruptions.
mod assets;
mod workflow;

use crate::{
    REPOSITORY, Result, artifact,
    io::{self, System},
    releases, require,
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    time::Duration,
};

const PRODUCTION: &str = "https://dispatch.dillonlille.com";
const HELP: &str = "Dispatch release [run|status|prepare|publish] [X.Y.Z] --root CHECKOUT
  run       Release, publish and verify Production (the legacy default).
  status    Inspect GitHub, saved assets and public health without changing release state.
  prepare   Merge the release PR and stop at a smoke-tested, verified draft.
  publish   Publish an existing verified preparation, verify Production and finish Dev sync.
Options: --bump patch|minor|major, --dev-commit REV, --notes PATH, --releases PATH
Rerun the same command after fixing a failure. Tags and existing assets are never overwritten.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Run,
    Status,
    Prepare,
    Publish,
}

struct Options {
    stage: Stage,
    version: Option<String>,
    root: PathBuf,
    bump: String,
    dev_commit: Option<String>,
    notes: Option<PathBuf>,
    releases: Option<PathBuf>,
}
impl Options {
    fn parse(args: &[String]) -> Result<Self> {
        let mut value = Self {
            stage: Stage::Run,
            version: None,
            root: PathBuf::new(),
            bump: "patch".into(),
            dev_commit: None,
            notes: None,
            releases: None,
        };
        let mut iter = args.iter().peekable();
        if let Some(stage) = iter.peek().and_then(|s| match s.as_str() {
            "run" => Some(Stage::Run),
            "status" => Some(Stage::Status),
            "prepare" => Some(Stage::Prepare),
            "publish" => Some(Stage::Publish),
            _ => None,
        }) {
            value.stage = stage;
            iter.next();
        }
        let mut seen = BTreeSet::new();
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--root" | "--bump" | "--dev-commit" | "--notes" | "--releases" => {
                    require(seen.insert(arg), "Duplicate release option")?;
                    let next = iter.next().ok_or("Release option needs a value")?;
                    require(!next.starts_with('-'), "Release option needs a value")?;
                    match arg.as_str() {
                        "--root" => value.root = std::path::absolute(next)?,
                        "--bump" => value.bump = next.clone(),
                        "--dev-commit" => value.dev_commit = Some(next.clone()),
                        "--notes" => value.notes = Some(std::path::absolute(next)?),
                        _ => value.releases = Some(std::path::absolute(next)?),
                    }
                }
                _ => {
                    require(value.version.is_none(), "Unexpected release argument")?;
                    releases::version(arg)?;
                    value.version = Some(arg.clone());
                }
            }
        }
        require(value.root.is_absolute(), "--root CHECKOUT is required")?;
        require(
            matches!(value.bump.as_str(), "patch" | "minor" | "major"),
            "Invalid version bump",
        )?;
        Ok(value)
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    format: u32,
    version: String,
    dev_commit: Option<String>,
    commit: Option<String>,
    complete: bool,
}

struct ReleaseLock(std::fs::File);
impl Drop for ReleaseLock {
    fn drop(&mut self) {
        // Closing our descriptor alone can leave flock held by a concurrent
        // fork until that child execs. Release the lock explicitly on every exit.
        let _ = FileExt::unlock(&self.0);
    }
}

struct Release<'a> {
    system: &'a dyn System,
    root: PathBuf,
    platform: PathBuf,
    directory: PathBuf,
    output: PathBuf,
    notes: PathBuf,
    version: String,
    tag: String,
    branch: String,
    sync_branch: String,
    worktree: PathBuf,
    sync_worktree: PathBuf,
}

fn say(message: impl std::fmt::Display) {
    eprintln!("[release] {message}");
}
fn next_version(latest: &str, bump: &str) -> Result<String> {
    let mut parts = releases::version(latest)?;
    let index = match bump {
        "major" => 0,
        "minor" => 1,
        "patch" => 2,
        _ => return Err("Invalid bump".into()),
    };
    parts[index] = parts[index].checked_add(1).ok_or("Version overflow")?;
    parts[index + 1..].fill(0);
    Ok(format!("{}.{}.{}", parts[0], parts[1], parts[2]))
}

impl<'a> Release<'a> {
    fn new(system: &'a dyn System, options: &Options, version: &str, platform: PathBuf) -> Self {
        let directory = options
            .releases
            .clone()
            .unwrap_or_else(|| platform.join("releases"));
        Self {
            system,
            root: options.root.clone(),
            output: directory.join(format!("v{version}")),
            notes: options
                .notes
                .clone()
                .unwrap_or_else(|| directory.join(format!("v{version}-notes.md"))),
            worktree: platform.join(format!("worktrees/release-v{version}")),
            sync_worktree: platform.join(format!("worktrees/sync-main-v{version}")),
            directory,
            platform,
            version: version.into(),
            tag: format!("v{version}"),
            branch: format!("release/v{version}"),
            sync_branch: format!("chore/sync-main-v{version}"),
        }
    }
    fn command(&self, args: &[&str], cwd: Option<&Path>, timeout: u64) -> Result<String> {
        Ok(String::from_utf8(self.system.command(
            args,
            Some(cwd.unwrap_or(&self.root)),
            timeout,
            None,
        )?)?
        .trim()
        .into())
    }
    fn api(&self, endpoint: &str, args: &[&str]) -> Result<Value> {
        let endpoint = format!("repos/{REPOSITORY}/{endpoint}");
        let mut command = vec!["gh", "api", &endpoint];
        command.extend_from_slice(args);
        Ok(serde_json::from_str(&self.command(&command, None, 120)?)?)
    }
    fn journal_path(&self) -> PathBuf {
        self.directory.join(format!(".{}-state.json", self.tag))
    }
    fn journal(&self) -> Result<Journal> {
        if !self.journal_path().try_exists()? {
            return Ok(Journal {
                format: 1,
                version: self.version.clone(),
                ..Default::default()
            });
        }
        let value: Journal = serde_json::from_value(io::read_json(&self.journal_path())?)?;
        require(
            value.format == 1
                && value.version == self.version
                && value
                    .dev_commit
                    .as_ref()
                    .is_none_or(|s| artifact::hex(s, 40))
                && value.commit.as_ref().is_none_or(|s| artifact::hex(s, 40)),
            "Invalid release journal",
        )?;
        Ok(value)
    }
    fn save(&self, journal: &Journal) -> Result<()> {
        io::write_json(&self.journal_path(), &serde_json::to_value(journal)?)
    }
    fn record_commit(&self, commit: &str) -> Result<()> {
        require(artifact::hex(commit, 40), "Full release commit required")?;
        let mut journal = self.journal()?;
        require(
            journal.commit.as_deref().is_none_or(|old| old == commit),
            "Release commit changed",
        )?;
        journal.commit = Some(commit.into());
        self.save(&journal)
    }
    fn listed_release(&self) -> Result<Option<Value>> {
        Ok(all_releases(self.system)?
            .into_iter()
            .find(|r| r["tag_name"] == self.tag))
    }
    fn checks(&self, sha: &str, event: &str, branch: Option<&str>, wait: bool) -> Result<Value> {
        let deadline = self.system.monotonic() + Duration::from_secs(if wait { 1800 } else { 0 });
        let mut announced = false;
        loop {
            let runs = io::github(
                self.system,
                &format!(
                    "actions/workflows/checks.yml/runs?event={event}&head_sha={sha}&per_page=100"
                ),
            )?;
            let run = releases::latest_run(
                &runs["workflow_runs"],
                sha,
                event,
                branch,
                event == "pull_request",
            );
            if let Some(run) = run {
                if !announced {
                    say(format!("Checks: {}", io::text(run, "html_url")));
                    announced = true;
                }
                if run["status"] == "completed" {
                    require(
                        releases::passed(run),
                        &format!(
                            "Checks ended with {}: {}. Fix the cause and rerun.",
                            io::text(run, "conclusion"),
                            io::text(run, "html_url")
                        ),
                    )?;
                    return Ok(run.clone());
                }
            }
            require(
                wait && self.system.monotonic() < deadline,
                "Checks have not passed for the selected commit",
            )?;
            self.system.sleep(Duration::from_secs(10));
        }
    }
    fn checked_source(&self, commit: &str) -> Result<Value> {
        require(artifact::hex(commit, 40), "Full source commit required")?;
        let comparison = io::github(self.system, &format!("compare/{commit}...main"))?;
        require(
            matches!(comparison["status"].as_str(), Some("ahead" | "identical")),
            "Source must be merged into main",
        )?;
        self.checks(commit, "push", Some("main"), false)
    }
    fn execute(&self, stage: Stage, dev_commit: Option<&str>) -> Result<Value> {
        if stage == Stage::Status {
            return self.status();
        }
        io::private_directory(&self.directory)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.directory.join(".release.lock"))?;
        lock.try_lock_exclusive()
            .map_err(|_| "Another release command is running")?;
        let _lock = ReleaseLock(lock);
        self.git(&["fetch", "origin", "main", "dev"], None, 300)?;
        let published = self.listed_release()?.is_some_and(|r| r["draft"] == false);
        if published {
            require(
                stage != Stage::Prepare,
                "Release is already published; use status or publish to verify it",
            )?;
        } else if stage != Stage::Publish {
            let commit = self.merge_release(dev_commit)?;
            self.record_commit(&commit)?;
            self.open_sync()?;
            let prepared = self.prepare(&commit)?;
            self.smoke(&prepared)?;
            self.ensure_draft(&prepared)?;
            if stage == Stage::Prepare {
                return Ok(
                    json!({"version":self.version,"stage":"draft-verified","commit":commit}),
                );
            }
        }
        // Publication can only consume complete, revalidated preparation. It never
        // creates or merges a release PR implicitly.
        let prepared = self.prepared(None)?;
        self.record_commit(&prepared.commit)?;
        let release = self.publish(&prepared)?;
        self.verify_production(&prepared, &release)?;
        self.finish_sync()?;
        self.clean()?;
        let mut journal = self.journal()?;
        journal.complete = true;
        self.save(&journal)?;
        Ok(
            json!({"version":self.version,"stage":"complete","release":release["html_url"],"runtimeDigest":prepared.runtime_digest}),
        )
    }
    fn status(&self) -> Result<Value> {
        let prepared = if self.output.try_exists()? {
            match self.prepared(None) {
                Ok(p) => json!({"valid":true,"commit":p.commit,"runtimeDigest":p.runtime_digest}),
                Err(error) => json!({"valid":false,"problem":error.to_string()}),
            }
        } else {
            Value::Null
        };
        let health = self
            .system
            .request(&format!("{PRODUCTION}/api/health"), false, true, 20)
            .and_then(io::json_response)
            .unwrap_or_else(|error| json!({"problem": error.to_string()}));
        Ok(
            json!({"version":self.version,"journal":self.journal()?,"prepared":prepared,
            "release":self.listed_release()?,"releasePr":self.pull_request(&self.branch,"main")?,
            "syncPr":self.pull_request(&self.sync_branch,"dev")?,"production":health}),
        )
    }
}

fn all_releases(system: &dyn System) -> Result<Vec<Value>> {
    let pages: Vec<Vec<Value>> = serde_json::from_slice(&system.command(
        &[
            "gh",
            "api",
            &format!("repos/{REPOSITORY}/releases?per_page=100"),
            "--paginate",
            "--slurp",
        ],
        None,
        120,
        None,
    )?)?;
    Ok(pages.into_iter().flatten().collect())
}
fn unfinished(system: &dyn System, directory: &Path, listed: &[Value]) -> Result<Option<String>> {
    let pulls: Vec<Value> = serde_json::from_slice(&system.command(
        &[
            "gh",
            "pr",
            "list",
            "--repo",
            REPOSITORY,
            "--base",
            "main",
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            "headRefName",
        ],
        None,
        120,
        None,
    )?)?;
    let mut found = BTreeSet::new();
    for pull in pulls {
        if let Some(v) = pull["headRefName"]
            .as_str()
            .and_then(|s| s.strip_prefix("release/v"))
        {
            found.insert(v.to_owned());
        }
    }
    for release in listed {
        if release["draft"] == true
            && let Some(v) = release["tag_name"]
                .as_str()
                .and_then(|s| s.strip_prefix('v'))
        {
            found.insert(v.to_owned());
        }
    }
    if directory.try_exists()? {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(".v") && name.ends_with("-state.json") {
                let journal: Journal = serde_json::from_value(io::read_json(&entry.path())?)?;
                require(
                    journal.format == 1 && name == format!(".v{}-state.json", journal.version),
                    "Invalid release journal",
                )?;
                if !journal.complete {
                    found.insert(journal.version);
                }
            } else if entry.file_type()?.is_dir()
                && !entry
                    .path()
                    .join("deployment-verification.json")
                    .try_exists()?
                && let Some(version) = name.strip_prefix('v')
            {
                found.insert(version.into());
            }
        }
    }
    found.retain(|v| releases::version(v).is_ok());
    require(
        found.len() <= 1,
        "Several releases are unfinished; name the version to continue",
    )?;
    Ok(found.into_iter().next())
}

pub fn run(args: &[String], system: &dyn System) -> Result<Value> {
    if args.iter().any(|s| matches!(s.as_str(), "--help" | "-h")) {
        println!("{HELP}");
        return Ok(Value::Null);
    }
    let options = Options::parse(args)?;
    let common = String::from_utf8(system.command(
        &[
            "git",
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
        ],
        Some(&options.root),
        120,
        None,
    )?)?;
    let platform = Path::new(common.trim())
        .parent()
        .and_then(Path::parent)
        .ok_or("Invalid checkout")?
        .to_path_buf();
    let listed = all_releases(system)?;
    let latest = listed
        .iter()
        .filter(|r| r["draft"] == false && r["prerelease"] == false)
        .filter_map(|r| r["tag_name"].as_str().and_then(|s| s.strip_prefix('v')))
        .filter_map(|s| releases::version(s).ok().map(|v| (v, s)))
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, s)| s)
        .unwrap_or("0.0.0");
    let directory = options
        .releases
        .clone()
        .unwrap_or_else(|| platform.join("releases"));
    let version = match &options.version {
        Some(version) => version.clone(),
        None => match unfinished(system, &directory, &listed)? {
            Some(version) => version,
            None if options.stage == Stage::Status => latest.into(),
            None if options.stage == Stage::Publish => {
                return Err("Name the prepared or published version to verify".into());
            }
            None => next_version(latest, &options.bump)?,
        },
    };
    if options.stage != Stage::Status {
        require(
            listed
                .iter()
                .any(|r| r["tag_name"] == format!("v{version}"))
                || releases::version(&version)? > releases::version(latest)?,
            "Version must be newer than the latest release",
        )?;
    }
    Release::new(system, &options, &version, platform)
        .execute(options.stage, options.dev_commit.as_deref())
}

#[cfg(test)]
mod tests;
