use crate::{
    Result,
    artifact::{self, Manifest},
    io::{self, System},
    management, releases, require,
};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Environment {
    Dev,
    Production,
}
impl Environment {
    pub fn name(self) -> &'static str {
        match self {
            Self::Dev => "dev",
            Self::Production => "production",
        }
    }
    fn service(self) -> &'static str {
        match self {
            Self::Dev => "dispatch-dev.service",
            Self::Production => "dispatch-production.service",
        }
    }
}
/// What the checks say about a commit Dev could install.
enum Checked {
    /// A passed run and the build it published.
    Passed(Value, Value),
    /// The run still deciding, or the one that failed, if there is one.
    Pending(Value),
}
pub struct Updater<'a> {
    pub root: PathBuf,
    pub active: PathBuf,
    pub runtime: PathBuf,
    pub platform: PathBuf,
    pub previous: PathBuf,
    pub receipt: PathBuf,
    pub status_file: PathBuf,
    pub environment: Environment,
    pub system: &'a dyn System,
    health_url: String,
    system_service: bool,
}
impl<'a> Updater<'a> {
    pub fn new(root: &Path, environment: Environment, system: &'a dyn System) -> Result<Self> {
        let root = std::path::absolute(root)?;
        require(
            root.file_name().and_then(|s| s.to_str())
                == Some(if environment == Environment::Dev {
                    "dev"
                } else {
                    "public"
                }),
            "Invalid environment root",
        )?;
        io::private_directory(&root)?;
        let runtime = root.join(".runtime");
        let platform = root.join("data/platform");
        io::private_directory(&runtime)?;
        io::private_directory(&platform)?;
        let active = root.join(if environment == Environment::Dev {
            ".build"
        } else {
            "live"
        });
        require(!active.is_symlink(), "Runtime symlink denied")?;
        let config = io::read_json(&root.join("config/updater.json"))?;
        let system_service = config.get("systemService").map_or(Ok(false), |value| {
            value.as_bool().ok_or("Invalid systemService")
        })?;
        require(
            !system_service || environment == Environment::Production,
            "System service is Production-only",
        )?;
        require(
            config["service"] == environment.service(),
            "Environment service required",
        )?;
        let health_url = io::text(&config, "healthUrl");
        require(
            regex::Regex::new(r"^http://127\.0\.0\.1:[0-9]+/api/health$")?.is_match(&health_url),
            "Loopback health endpoint required",
        )?;
        if environment == Environment::Dev {
            require(
                root.join(".git").is_dir(),
                "Dev requires its persistent repository checkout",
            )?;
            let exclude = root.join(".git/info/exclude");
            let existing = fs::read_to_string(&exclude).unwrap_or_default();
            let mut out = OpenOptions::new()
                .create(true)
                .append(true)
                .mode(0o600)
                .open(exclude)?;
            for name in ["config", "data", "dsps", ".platform.lock"] {
                if !existing.lines().any(|line| line == format!("/{name}")) {
                    writeln!(out, "/{name}")?;
                }
            }
        }
        let name = environment.name();
        Ok(Self {
            previous: runtime.join("previous"),
            receipt: platform.join(format!("{name}-activation.json")),
            status_file: platform.join(format!("{name}-update.json")),
            root,
            active,
            runtime,
            platform,
            environment,
            system,
            health_url,
            system_service,
        })
    }
    pub fn git(&self, args: &[&str]) -> Result<String> {
        let mut cmd = vec!["git"];
        cmd.extend_from_slice(args);
        Ok(
            String::from_utf8(self.system.command(&cmd, Some(&self.root), 120, None)?)?
                .trim()
                .to_owned(),
        )
    }
    /// The branch Dev follows: main. A checkout still on `dev`, as a legacy host handing
    /// over from the Python updater is, keeps following it until it is moved onto main.
    pub fn tracked_branch(&self) -> Result<&'static str> {
        let branch = self.git(&["branch", "--show-current"])?;
        ["main", "dev"]
            .into_iter()
            .find(|trusted| *trusted == branch)
            .ok_or_else(|| "Dev checkout must be on main".into())
    }
    pub fn clean_checkout(&self) -> Result<()> {
        self.tracked_branch()?;
        require(
            self.git(&["status", "--porcelain", "--untracked-files=all"])?
                .is_empty(),
            "Dev checkout contains unfinished changes",
        )?;
        let origin = self.git(&["remote", "get-url", "origin"])?;
        require(
            crate::REPOSITORIES.iter().any(|name| {
                origin == format!("https://github.com/{name}.git")
                    || origin == format!("git@github.com:{name}.git")
            }),
            "Unexpected repository origin",
        )?;
        self.check_source("HEAD")
    }
    fn check_source(&self, commit: &str) -> Result<()> {
        require(
            self.git(&[
                "ls-tree",
                "-r",
                "--name-only",
                commit,
                "--",
                "config",
                "data",
                "dsps",
                ".platform.lock",
            ])?
            .is_empty(),
            "Dev source must not contain private environment paths",
        )
    }
    fn service(&self, action: &str) -> Result<()> {
        let args = if self.system_service {
            vec![
                "sudo",
                "-n",
                "/usr/bin/systemctl",
                action,
                self.environment.service(),
            ]
        } else {
            vec!["systemctl", "--user", action, self.environment.service()]
        };
        self.system.command(&args, None, 90, None)?;
        Ok(())
    }
    fn healthy(&self, digest: &str, timeout: u64) -> bool {
        let deadline = self.system.monotonic() + Duration::from_secs(timeout);
        loop {
            if let Ok(value) = self
                .system
                .request(&self.health_url, false, false, 2)
                .and_then(io::json_response)
                && value["status"] == "ready"
                && value["release"] == digest
                && value["environment"]
                    == if self.environment == Environment::Dev {
                        "preview"
                    } else {
                        "production"
                    }
                && (self.environment == Environment::Dev || value["runtime"] == "rust")
            {
                return true;
            }
            if self.system.monotonic() >= deadline {
                return false;
            }
            self.system.sleep(Duration::from_secs(1));
        }
    }
    fn status(&self, state: &str, manifest: &Manifest, extra: Value) -> Result<()> {
        let mut value = json!({"status":state,"digest":manifest.digest,"updatedAt":chrono::Utc::now().to_rfc3339()});
        if self.environment == Environment::Production {
            value["version"] = json!(manifest.version);
        }
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().ok_or("Invalid status")?.clone());
        io::write_json(&self.status_file, &value)
    }
    pub fn verify(&self) -> Result<Manifest> {
        let manifest = if self.environment == Environment::Dev {
            self.clean_checkout()?;
            artifact::verify(&self.active, Some(&self.git(&["rev-parse", "HEAD"])?))?
        } else {
            let m = artifact::verify(&self.active, None)?;
            releases::version(&m.version)?;
            m
        };
        fs::set_permissions(
            self.active.join("services/rust/dispatch-backend"),
            fs::Permissions::from_mode(0o700),
        )?;
        Ok(manifest)
    }
    pub fn recover(&self) -> Result<()> {
        if !self.receipt.try_exists()? {
            return Ok(());
        }
        let receipt = io::read_json(&self.receipt)?;
        let old_digest = io::text(&receipt, "oldDigest");
        require(artifact::hex(&old_digest, 64), "Invalid activation receipt")?;
        let old_commit = io::text(&receipt, "oldCommit");
        if self.environment == Environment::Dev {
            let commit = io::text(&receipt, "commit");
            require(
                receipt["previous"] == "previous"
                    && artifact::hex(&old_commit, 40)
                    && artifact::hex(&commit, 40),
                "Invalid activation receipt",
            )?;
            self.clean_checkout()?;
            require(
                [old_commit.as_str(), commit.as_str()]
                    .contains(&self.git(&["rev-parse", "HEAD"])?.as_str()),
                "Checkout changed during interrupted update",
            )?;
        } else {
            require(
                artifact::hex(&io::text(&receipt, "newDigest"), 64),
                "Invalid activation receipt",
            )?;
        }
        self.service("stop")?;
        let retained = self.previous.try_exists()?;
        let source = if retained {
            &self.previous
        } else {
            &self.active
        };
        let old = artifact::verify(
            source,
            (self.environment == Environment::Dev).then_some(old_commit.as_str()),
        )?;
        require(old.digest == old_digest, "Rollback inventory differs")?;
        if retained {
            if self.active.try_exists()? {
                artifact::real_directory(&self.active)?;
                fs::remove_dir_all(&self.active)?;
            }
            fs::rename(&self.previous, &self.active)?;
        }
        if self.environment == Environment::Dev {
            self.git(&["reset", "--hard", &old_commit])?;
        }
        fs::set_permissions(
            self.active.join("services/rust/dispatch-backend"),
            fs::Permissions::from_mode(0o700),
        )?;
        self.service("start")?;
        require(
            self.healthy(&old_digest, 40),
            "Previous runtime failed health check",
        )?;
        self.status(
            "rolled_back",
            &old,
            if self.environment == Environment::Dev {
                json!({"commit":old_commit})
            } else {
                json!({"failedDigest":receipt["newDigest"]})
            },
        )?;
        io::remove_receipt(&self.receipt)
    }
    pub fn activate(&self, candidate: &Path, commit: &str) -> Result<()> {
        require(artifact::hex(commit, 40), "Invalid build commit")?;
        let manifest = artifact::verify(candidate, Some(commit))?;
        let current = if self.environment == Environment::Dev {
            self.clean_checkout()?;
            self.check_source(commit)?;
            Some(self.git(&["rev-parse", "HEAD"])?)
        } else {
            None
        };
        let old = artifact::verify(&self.active, current.as_deref())?;
        require(
            old.schema == manifest.schema,
            "Schema change requires an explicit migration plan",
        )?;
        if let Some(current) = &current {
            self.git(&["merge-base", "--is-ancestor", current, commit])?;
            let tracked = format!("origin/{}", self.tracked_branch()?);
            self.git(&["merge-base", "--is-ancestor", commit, &tracked])?;
        } else {
            require(
                releases::version(&manifest.version)? > releases::version(&old.version)?,
                "Release downgrade/replacement denied",
            )?;
        }
        fs::set_permissions(
            candidate.join("services/rust/dispatch-backend"),
            fs::Permissions::from_mode(0o700),
        )?;
        if self.previous.try_exists()? {
            artifact::real_directory(&self.previous)?;
            fs::remove_dir_all(&self.previous)?;
        }
        let record = if let Some(current) = &current {
            json!({"commit":commit,"oldCommit":current,"oldDigest":old.digest,"previous":"previous"})
        } else {
            json!({"oldDigest":old.digest,"newDigest":manifest.digest})
        };
        io::write_json(&self.receipt, &record)?;
        let activation = (|| -> Result<()> {
            self.service("stop")?;
            if let Some(current) = &current {
                self.clean_checkout()?;
                require(
                    self.git(&["rev-parse", "HEAD"])? == *current,
                    "Checkout changed during update",
                )?;
            }
            fs::rename(&self.active, &self.previous)?;
            fs::rename(candidate, &self.active)?;
            if current.is_some() {
                self.git(&["merge", "--ff-only", commit])?;
            }
            self.service("start")?;
            require(
                self.healthy(&manifest.digest, 40),
                "New runtime failed health check",
            )?;
            self.status("ready", &manifest, json!({"commit":commit}))?;
            io::remove_receipt(&self.receipt)
        })();
        if let Err(error) = activation {
            self.recover()?;
            return Err(error);
        }
        Ok(())
    }
    pub fn run_locked(&self) -> Result<()> {
        // Another run of this environment holds the lock: this one has nothing to do.
        let Some(_lock) = io::ExclusiveLock::try_acquire(
            &self
                .platform
                .join(format!("{}-update.lock", self.environment.name())),
        )?
        else {
            return Ok(());
        };
        self.recover()?;
        match self.environment {
            Environment::Dev => self.update_dev(),
            Environment::Production => self.update_production(),
        }
    }
    /// Wait until Dev runs `commit`, or a later commit of its branch that contains it, and
    /// confirm it is live: recorded ready, the checkout clean on it, the recorded runtime
    /// installed, the service active and healthy.
    pub fn wait(&self, commit: &str, timeout: u64) -> Result<Value> {
        require(
            self.environment == Environment::Dev,
            "Only Dev follows commits",
        )?;
        require(artifact::hex(commit, 40), "Full commit required")?;
        let deadline = self.system.monotonic() + Duration::from_secs(timeout);
        loop {
            let last = match self.live(commit) {
                Ok(Some(live)) => return Ok(live),
                Ok(None) => io::read_json(&self.status_file)
                    .map_or_else(|error| error.to_string(), |status| status.to_string()),
                Err(error) => error.to_string(),
            };
            if self.system.monotonic() >= deadline {
                return Err(
                    format!("Dev did not install {commit} within {timeout}s: {last}").into(),
                );
            }
            self.system.sleep(Duration::from_secs(5));
        }
    }
    fn live(&self, commit: &str) -> Result<Option<Value>> {
        let status = io::read_json(&self.status_file)?;
        let installed = io::text(&status, "commit");
        if status["status"] != "ready"
            || !artifact::hex(&installed, 40)
            || self
                .git(&["merge-base", "--is-ancestor", commit, &installed])
                .is_err()
        {
            return Ok(None);
        }
        let manifest = self.verify()?;
        require(
            self.git(&["rev-parse", "HEAD"])? == installed,
            "Checkout differs from the installed commit",
        )?;
        require(
            status["digest"] == manifest.digest,
            "Runtime differs from the one the updater installed",
        )?;
        self.service("is-active")?;
        require(
            self.healthy(&manifest.digest, 10),
            "Dev is not healthy on its runtime",
        )?;
        Ok(Some(
            json!({"commit":installed,"digest":manifest.digest,"status":"live"}),
        ))
    }
    fn update_dev(&self) -> Result<()> {
        self.clean_checkout()?;
        let branch = self.tracked_branch()?;
        let tracked = format!("origin/{branch}");
        self.git(&["fetch", "origin", branch])?;
        let commit = self.git(&["rev-parse", &tracked])?;
        let current = self.git(&["rev-parse", "HEAD"])?;
        if commit == current {
            return Ok(());
        }
        let current_manifest = artifact::verify(&self.active, Some(&current))?;
        let waiting = |run: &Value| {
            self.status(
                if run["status"] == "completed" {
                    "checks_failed"
                } else {
                    "waiting_for_checks"
                },
                &current_manifest,
                json!({"commit":current}),
            )
        };
        let (run, record) = match self.validated_build(branch, &commit)? {
            Checked::Passed(run, record) => (run, record),
            Checked::Pending(run) => return waiting(&run),
        };
        let temp = tempfile::Builder::new()
            .prefix("update-")
            .tempdir_in(&self.runtime)?;
        releases::download_run(self.system, &record, temp.path(), &commit, None)?;
        self.git(&["fetch", "origin", branch])?;
        if self.git(&["rev-parse", &tracked])? != commit {
            return waiting(&Value::Null);
        }
        // A rerun can revoke validation during a download, even when the head stays put.
        match self.validated_build(branch, &commit)? {
            Checked::Passed(again, _) if again == run => {}
            _ => return waiting(&Value::Null),
        }
        self.activate(&temp.path().join("candidate"), &commit)?;
        // Only after an install: hashing the manager and the runtime on every tick cost
        // more than the rest of the check together.
        management::refresh(self)?;
        eprintln!(
            "Installed {commit} from the {} run {}",
            io::text(&run, "event"),
            run["id"]
        );
        Ok(())
    }
    /// A passed run of the checks for `commit` and the build it published, or the run still
    /// deciding, if any. The merge queue tests exactly the commit GitHub then pushes to main,
    /// whose push run only reuses those bytes, so a queue run decides when there is one. A
    /// commit that reached the branch another way, or whose queue build expired, waits for
    /// its push run.
    fn validated_build(&self, branch: &str, commit: &str) -> Result<Checked> {
        let queued = io::github(
            self.system,
            &format!(
                "actions/workflows/checks.yml/runs?event=merge_group&head_sha={commit}&per_page=20"
            ),
        )?;
        let prefix = format!("gh-readonly-queue/{branch}/");
        let groups: Vec<Value> = queued["workflow_runs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|run| {
                run["head_branch"]
                    .as_str()
                    .is_some_and(|name| name.starts_with(&prefix))
            })
            .cloned()
            .collect();
        if let Some(run) =
            releases::latest_run(&Value::Array(groups), commit, "merge_group", None, false)
        {
            if !releases::passed(run) {
                return Ok(Checked::Pending(run.clone()));
            }
            let name = format!(
                "dispatch-pr-build-{}-{}",
                run["id"].as_u64().ok_or("Invalid workflow id")?,
                run["run_attempt"].as_u64().unwrap_or(1)
            );
            if let Some(record) = self.build(run, &name)? {
                return Ok(Checked::Passed(run.clone(), record));
            }
        }
        let pushed = io::github(
            self.system,
            &format!(
                "actions/workflows/checks.yml/runs?branch={branch}&event=push&head_sha={commit}&per_page=20"
            ),
        )?;
        let run = releases::latest_run(
            &pushed["workflow_runs"],
            commit,
            "push",
            Some(branch),
            false,
        )
        .cloned()
        .unwrap_or(Value::Null);
        if !releases::passed(&run) {
            return Ok(Checked::Pending(run));
        }
        let record = self
            .build(&run, &format!("dispatch-{branch}-{commit}"))?
            .ok_or("Verified Dev artifact unavailable")?;
        Ok(Checked::Passed(run, record))
    }
    /// The unexpired build `name` that `run` published.
    fn build(&self, run: &Value, name: &str) -> Result<Option<Value>> {
        let id = run["id"].as_u64().ok_or("Invalid workflow id")?;
        let artifacts = io::github(self.system, &format!("actions/runs/{id}/artifacts"))?;
        let matches: Vec<_> = artifacts["artifacts"]
            .as_array()
            .ok_or("Missing artifacts")?
            .iter()
            .filter(|a| a["name"] == name && a["expired"] == false)
            .collect();
        require(matches.len() <= 1, "Verified Dev artifact is ambiguous")?;
        Ok(matches.first().map(|record| (*record).clone()))
    }
    fn settled(&self, digest: &str) -> bool {
        let Ok(check) = io::read_json(&self.platform.join("production-release-check.json")) else {
            return false;
        };
        let age = self.system.now() - check["checkedAt"].as_f64().unwrap_or(f64::NEG_INFINITY);
        (0.0..600.0).contains(&age)
            && check["digest"] == digest
            && check["tag"]
                .as_str()
                .is_some_and(|tag| releases::latest_tag(self.system).as_deref() == Some(tag))
    }
    fn settle(&self, release: &Value, current: &Manifest) -> Result<()> {
        io::write_json(
            &self.platform.join("production-release-check.json"),
            &json!({"tag":release["tag_name"],"digest":current.digest,"checkedAt":self.system.now()}),
        )
    }
    fn update_production(&self) -> Result<()> {
        // Nothing new since the last full check: the recorded digest tells, so the runtime is
        // hashed again only once there may be something to do, at least every ten minutes.
        if self.settled(&artifact::manifest(&self.active)?.digest) {
            return Ok(());
        }
        let retry = self.platform.join("production-update-retry.json");
        let pending = io::read_json(&retry).unwrap_or(Value::Null);
        if self.system.now() < pending["retryAt"].as_f64().unwrap_or(f64::NEG_INFINITY) {
            return Ok(());
        }
        let result = self.install_latest();
        if result.is_ok() {
            if retry.try_exists()? {
                fs::remove_file(&retry)?;
            }
        } else {
            // This host has 60 unauthenticated GitHub API calls an hour, and an attempt makes
            // up to five, so a failure repeated every 30 seconds would soon exhaust them. Wait
            // 1, 2, 4, 8, then 10 minutes between attempts.
            let failures = pending["failures"].as_u64().unwrap_or(0) + 1;
            let delay = (60u64 << (failures - 1).min(4)).min(600);
            let record = json!({"failures":failures,"retryAt":self.system.now() + delay as f64});
            if let Err(error) = io::write_json(&retry, &record) {
                eprintln!("Retry delay was not recorded: {error}");
            }
        }
        result
    }
    fn install_latest(&self) -> Result<()> {
        let current = artifact::verify(&self.active, None)?;
        let release = releases::public_github(self.system, "releases/latest")?;
        let selected = releases::release_version(&release)?;
        let order = releases::version(&selected)?.cmp(&releases::version(&current.version)?);
        if order.is_lt() {
            return self.settle(&release, &current);
        }
        if order.is_eq() {
            require(
                self.healthy(&current.digest, 5),
                "Installed Production runtime is not healthy",
            )?;
            let status = io::read_json(&self.status_file).unwrap_or(Value::Null);
            if status["status"] != "ready" || status["digest"] != current.digest {
                self.status("ready",&current,json!({"commit":io::read_json(&self.active.join("tooling/build-info.json"))?["commit"]}))?;
            }
            return self.settle(&release, &current);
        }
        if self.status_file.exists()
            && io::read_json(&self.status_file)?["failedReleaseId"] == release["id"]
        {
            return self.settle(&release, &current);
        }
        let commit = releases::release_commit(self.system, &io::text(&release, "tag_name"))?;
        let temp = tempfile::Builder::new()
            .prefix("update-")
            .tempdir_in(&self.runtime)?;
        let archive = temp.path().join("runtime.tar.gz");
        releases::download_asset(
            self.system,
            &release,
            &format!("dispatch-platform-{selected}.tar.gz"),
            &archive,
        )?;
        releases::download_asset(
            self.system,
            &release,
            "release.json",
            &temp.path().join("release.json"),
        )?;
        let candidate = temp.path().join("candidate");
        artifact::unpack(&archive, &candidate)?;
        let manifest = artifact::verify(&candidate, Some(&commit))?;
        require(
            manifest.version == selected,
            "Artifact version does not match release",
        )?;
        let published: Manifest =
            serde_json::from_value(io::read_json(&temp.path().join("release.json"))?)?;
        require(published == manifest, "Published release inventory differs")?;
        if releases::public_github(self.system, "releases/latest")?["id"] != release["id"] {
            return Ok(());
        }
        if let Err(error) = self.activate(&candidate, &commit) {
            if !self.receipt.exists() {
                self.status(
                    "rolled_back",
                    &artifact::verify(&self.active, None)?,
                    json!({"failedReleaseId":release["id"],"failedDigest":manifest.digest}),
                )?;
            }
            return Err(error);
        }
        // Adopt the updater the release just proved healthy, as Dev does. Only after an
        // activation, never on an ordinary tick, so an operator who restores the previous
        // updater by hand keeps it until the next release. A copy that fails its own
        // self-check is not installed and the running updater stays.
        management::refresh(self)
    }
}
