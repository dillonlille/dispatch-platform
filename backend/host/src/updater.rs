use crate::{
    REPOSITORY, Result,
    artifact::{self, Manifest},
    io::{self, System},
    management, releases, require,
};
use fs2::FileExt;
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
    pub fn clean_checkout(&self) -> Result<()> {
        require(
            self.git(&["branch", "--show-current"])? == "dev",
            "Dev checkout is on another branch",
        )?;
        require(
            self.git(&["status", "--porcelain", "--untracked-files=all"])?
                .is_empty(),
            "Dev checkout contains unfinished changes",
        )?;
        let origin = self.git(&["remote", "get-url", "origin"])?;
        require(
            origin == format!("https://github.com/{REPOSITORY}.git")
                || origin == format!("git@github.com:{REPOSITORY}.git"),
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
        self.system.command(
            &["systemctl", "--user", action, self.environment.service()],
            None,
            90,
            None,
        )?;
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
            self.git(&["merge-base", "--is-ancestor", commit, "origin/dev"])?;
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
        let lock = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(
                self.platform
                    .join(format!("{}-update.lock", self.environment.name())),
            )?;
        match FileExt::try_lock_exclusive(&lock) {
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
            result => result?,
        }
        self.recover()?;
        match self.environment {
            Environment::Dev => self.update_dev(),
            Environment::Production => self.update_production(),
        }
    }
    fn update_dev(&self) -> Result<()> {
        self.clean_checkout()?;
        management::refresh(self)?;
        self.git(&["fetch", "origin", "dev"])?;
        let commit = self.git(&["rev-parse", "origin/dev"])?;
        let current = self.git(&["rev-parse", "HEAD"])?;
        if commit == current {
            return Ok(());
        }
        let current_manifest = artifact::verify(&self.active, Some(&current))?;
        let runs = io::github(
            self.system,
            &format!(
                "actions/workflows/checks.yml/runs?branch=dev&event=push&head_sha={commit}&per_page=20"
            ),
        )?;
        let run = releases::latest_run(&runs["workflow_runs"], &commit, "push", Some("dev"), false)
            .cloned()
            .unwrap_or(Value::Null);
        if !releases::passed(&run) {
            return self.status(
                if run["status"] == "completed" {
                    "checks_failed"
                } else {
                    "waiting_for_checks"
                },
                &current_manifest,
                json!({"commit":current}),
            );
        }
        let id = run["id"].as_u64().ok_or("Invalid workflow id")?;
        let artifacts = io::github(self.system, &format!("actions/runs/{id}/artifacts"))?;
        let matches: Vec<_> = artifacts["artifacts"]
            .as_array()
            .ok_or("Missing artifacts")?
            .iter()
            .filter(|a| a["name"] == format!("dispatch-dev-{commit}") && a["expired"] == false)
            .collect();
        require(matches.len() == 1, "Verified Dev artifact unavailable")?;
        let temp = tempfile::Builder::new()
            .prefix("update-")
            .tempdir_in(&self.runtime)?;
        releases::download_run(self.system, matches[0], temp.path(), &commit, None)?;
        self.git(&["fetch", "origin", "dev"])?;
        if self.git(&["rev-parse", "origin/dev"])? != commit {
            return self.status(
                "waiting_for_checks",
                &current_manifest,
                json!({"commit":current}),
            );
        }
        // A rerun can revoke validation during a download, even when the head stays put.
        let recheck = io::github(
            self.system,
            &format!(
                "actions/workflows/checks.yml/runs?branch=dev&event=push&head_sha={commit}&per_page=20"
            ),
        )?;
        if releases::latest_run(
            &recheck["workflow_runs"],
            &commit,
            "push",
            Some("dev"),
            false,
        ) != Some(&run)
        {
            return self.status(
                "waiting_for_checks",
                &current_manifest,
                json!({"commit":current}),
            );
        }
        self.activate(&temp.path().join("candidate"), &commit)?;
        management::refresh(self)
    }
    fn settled(&self, current: &Manifest) -> bool {
        let Ok(check) = io::read_json(&self.platform.join("production-release-check.json")) else {
            return false;
        };
        let age = self.system.now() - check["checkedAt"].as_f64().unwrap_or(f64::NEG_INFINITY);
        (0.0..600.0).contains(&age)
            && check["digest"] == current.digest
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
        let current = artifact::verify(&self.active, None)?;
        if self.settled(&current) {
            return Ok(());
        }
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
        Ok(())
    }
}
