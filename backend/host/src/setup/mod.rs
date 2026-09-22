//! Fresh host initialization stages private state before publishing configuration.
#[cfg(test)]
mod tests;
mod transaction;
use crate::{
    Result, artifact,
    io::{self, System},
    management, releases, require,
    updater::Environment,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Options {
    root: PathBuf,
    production: bool,
    origin: String,
    email: String,
    first: String,
    last: String,
    provider: String,
    sandbox: Option<PathBuf>,
    archive: Option<PathBuf>,
    commit: Option<String>,
    version: Option<String>,
}
impl Options {
    fn environment(&self) -> Environment {
        if self.production {
            Environment::Production
        } else {
            Environment::Dev
        }
    }
    fn validate(&self) -> Result<()> {
        require(
            self.root.file_name().and_then(|s| s.to_str())
                == Some(if self.production { "public" } else { "dev" }),
            "Real environment root required",
        )?;
        let origin = reqwest::Url::parse(&self.origin)?;
        require(
            origin.scheme() == "https"
                && origin.host_str().is_some()
                && origin.username().is_empty()
                && origin.password().is_none()
                && origin.query().is_none()
                && origin.fragment().is_none()
                && origin.path() == "/"
                && origin.as_str() == format!("{}/", self.origin),
            "Canonical HTTPS origin required",
        )?;
        for value in [&self.origin, &self.email, &self.first, &self.last] {
            require(
                !value.trim().is_empty() && !value.contains(['\n', '\r', '\0']),
                "Single-line setup values required",
            )?;
        }
        require(
            self.email.contains('@')
                && self.first.chars().count() <= 100
                && self.last.chars().count() <= 100,
            "Owner email, first and last names required",
        )?;
        require(
            matches!(self.provider.as_str(), "native" | "fixture")
                && (!self.production || self.provider == "native"),
            "Invalid setup provider",
        )?;
        if let Some(path) = &self.sandbox {
            let metadata = path.symlink_metadata()?;
            require(
                path.canonicalize()? == *path
                    && metadata.is_file()
                    && metadata.uid() == 0
                    && metadata.mode() & 0o022 == 0,
                "Root-owned sandbox executable required",
            )?;
        }
        if self.production {
            require(
                self.archive.is_some() && self.sandbox.is_some(),
                "Production artifact and sandbox required",
            )?;
            require(
                self.commit.as_deref().is_some_and(|s| artifact::hex(s, 40)),
                "Release source commit required",
            )?;
            releases::version(self.version.as_deref().ok_or("Release version required")?)?;
        } else {
            require(
                self.archive.is_none() && self.commit.is_none() && self.version.is_none(),
                "Release arguments are only for Production",
            )?;
        }
        Ok(())
    }
}
fn parse(args: &[String]) -> Result<Options> {
    let environment = args.first().ok_or("Choose dev or production")?;
    require(
        matches!(environment.as_str(), "dev" | "production"),
        "Choose dev or production",
    )?;
    let mut values = BTreeMap::new();
    let mut arguments = args[1..].iter();
    while let Some(key) = arguments.next() {
        require(
            [
                "--root",
                "--origin",
                "--owner-email",
                "--first-name",
                "--last-name",
                "--provider",
                "--sandbox-executable",
                "--artifact",
                "--commit",
                "--version",
            ]
            .contains(&key.as_str()),
            "Unknown setup argument",
        )?;
        require(
            values
                .insert(
                    key.as_str(),
                    arguments
                        .next()
                        .ok_or("Setup argument value required")?
                        .clone(),
                )
                .is_none(),
            "Duplicate setup argument",
        )?;
    }
    let required = |key| -> Result<String> {
        values
            .get(key)
            .cloned()
            .ok_or_else(|| format!("{key} required").into())
    };
    let path = |key| values.get(key).map(std::path::absolute).transpose();
    Ok(Options {
        root: std::path::absolute(required("--root")?)?,
        production: environment == "production",
        origin: required("--origin")?,
        email: required("--owner-email")?,
        first: required("--first-name")?,
        last: required("--last-name")?,
        provider: values.get("--provider").cloned().unwrap_or("native".into()),
        sandbox: path("--sandbox-executable")?,
        archive: path("--artifact")?,
        commit: values.get("--commit").cloned(),
        version: values.get("--version").cloned(),
    })
}
pub fn run(args: &[String], system: &dyn System) -> Result<()> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!(
            "host setup <dev|production> --root PATH --origin HTTPS_ORIGIN --owner-email EMAIL --first-name NAME --last-name NAME [--provider native|fixture] [--sandbox-executable PATH] [--artifact ARCHIVE --commit SHA --version VERSION]"
        );
        return Ok(());
    }
    initialize(&parse(args)?, system)
}
fn initialize(options: &Options, system: &dyn System) -> Result<()> {
    options.validate()?;
    io::private_directory(&options.root)?;
    let runtime = options.root.join(".runtime");
    io::private_directory(&runtime)?;
    let _lock = io::ExclusiveLock::acquire(&runtime.join("setup.lock"))?;
    let receipt = runtime.join("setup.json");
    let journal = if receipt.exists() {
        let journal: transaction::Journal = serde_json::from_value(io::read_json(&receipt)?)?;
        journal.validate(options)?;
        if journal.prepared {
            journal
        } else {
            transaction::fresh(options)?;
            fs::remove_dir_all(runtime.join(&journal.staging))?;
            io::remove_receipt(&receipt)?;
            prepare(options, system)?
        }
    } else {
        transaction::fresh(options)?;
        prepare(options, system)?
    };
    transaction::publish(&journal)?;
    println!(
        "{} initialized. Initial login is private in {}",
        if options.production {
            "Production"
        } else {
            "Dev"
        },
        options.root.join("config/initial-owner.json").display()
    );
    println!("Install the reviewed systemd units separately to start the platform and updater.");
    Ok(())
}
fn prepare(options: &Options, system: &dyn System) -> Result<transaction::Journal> {
    let (dev_commit, dev_manifest) = if !options.production {
        require(
            options.root.join(".git").is_dir(),
            "Persistent Dev checkout required",
        )?;
        let git = |args: &[&str]| -> Result<String> {
            let mut command = vec!["git"];
            command.extend_from_slice(args);
            Ok(
                String::from_utf8(system.command(&command, Some(&options.root), 120, None)?)?
                    .trim()
                    .into(),
            )
        };
        let branch = git(&["branch", "--show-current"])?;
        require(
            matches!(branch.as_str(), "main" | "dev")
                && git(&["status", "--porcelain"])?.is_empty(),
            "Clean Dev checkout on main or dev required",
        )?;
        let origin = git(&["remote", "get-url", "origin"])?;
        require(
            crate::REPOSITORIES.iter().any(|name| {
                origin == format!("https://github.com/{name}.git")
                    || origin == format!("git@github.com:{name}.git")
            }),
            "Unexpected repository origin",
        )?;
        require(
            git(&[
                "ls-tree",
                "-r",
                "--name-only",
                "HEAD",
                "--",
                "config",
                "data",
                "dsps",
                ".platform.lock",
            ])?
            .is_empty(),
            "Dev source must not contain private environment paths",
        )?;
        git(&["fetch", "origin", &branch])?;
        let commit = git(&["rev-parse", "HEAD"])?;
        require(
            commit == git(&["rev-parse", &format!("origin/{branch}")])?,
            "Setup requires the merged HEAD of the branch Dev follows",
        )?;
        let manifest = artifact::verify(&options.root.join(".build"), Some(&commit))?;
        (Some(commit), Some(manifest))
    } else {
        (None, None)
    };
    let staging = tempfile::Builder::new()
        .prefix(".setup-")
        .tempdir_in(options.root.join(".runtime"))?
        .keep();
    let mut journal =
        transaction::Journal::new(options, staging.file_name().unwrap().to_str().unwrap());
    journal.write()?;
    for name in ["config", "data/platform", "dsps"] {
        io::private_directory(&staging.join(name))?;
    }
    let active = if options.production {
        staging.join("live")
    } else {
        options.root.join(".build")
    };
    let commit = options
        .commit
        .as_ref()
        .or(dev_commit.as_ref())
        .ok_or("Source commit required")?;
    let manifest = if let Some(manifest) = dev_manifest {
        manifest
    } else {
        artifact::unpack(
            options.archive.as_ref().ok_or("Artifact required")?,
            &active,
        )?;
        let manifest = artifact::verify(&active, Some(commit))?;
        require(
            Some(&manifest.version) == options.version.as_ref(),
            "Release version differs",
        )?;
        manifest
    };
    require(
        management::supported(&active)?,
        "Verified runtime must support Rust host management",
    )?;
    management::prepare_bundle(
        system,
        &active,
        &staging.join("management"),
        options.environment(),
        &manifest,
    )?;
    let mut entropy = [0u8; 30];
    fs::File::open("/dev/urandom")?.read_exact(&mut entropy)?;
    let password: String = entropy.iter().map(|byte| format!("{byte:02x}")).collect();
    io::write_json(
        &staging.join("config/initial-owner.json"),
        &json!({"email":options.email,"password":password,"url":options.origin}),
    )?;
    let mut env: BTreeMap<String, String> = [
        ("NODE_ENV", "production"),
        ("DISPATCH_STANDALONE", "1"),
        (
            "DISPATCH_ENVIRONMENT",
            if options.production {
                "production"
            } else {
                "preview"
            },
        ),
        ("DISPATCH_TRUSTED_PROXY", "cloudflare"),
        ("DISPATCH_PROVIDER_MODE", &options.provider),
        ("PORT", "5180"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect();
    env.insert("DISPATCH_ORIGIN".into(), options.origin.clone());
    env.insert(
        "DISPATCH_STATE_ROOT".into(),
        staging.to_str().ok_or("Invalid state path")?.into(),
    );
    if let Some(sandbox) = &options.sandbox {
        env.insert(
            "DISPATCH_BWRAP_EXECUTABLE".into(),
            sandbox.to_str().ok_or("Invalid sandbox path")?.into(),
        );
    }
    let binary = active.join("services/rust/dispatch-backend");
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700))?;
    system.bootstrap(
        &[
            binary.to_str().ok_or("Invalid bootstrap path")?,
            "bootstrap",
            &options.email,
            &options.first,
            &options.last,
        ],
        &active,
        &env,
        format!("{password}\n").as_bytes(),
    )?;
    require(
        staging.join("data/platform/accounts.sqlite").is_file(),
        "Bootstrap did not create the accounts database",
    )?;
    env.insert(
        "DISPATCH_STATE_ROOT".into(),
        options.root.to_str().ok_or("Invalid root")?.into(),
    );
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(staging.join("config/platform.env"))?;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    for (key, value) in env {
        writeln!(file, "{key}={}", serde_json::to_string(&value)?)?;
    }
    file.sync_all()?;
    io::write_json(
        &staging.join("config/updater.json"),
        &json!({"service":format!("dispatch-{}.service",options.environment().name()),"healthUrl":"http://127.0.0.1:5180/api/health"}),
    )?;
    io::write_json(
        &staging.join("config/setup.json"),
        &json!({"staging":journal.staging,"commit":commit,"digest":manifest.digest}),
    )?;
    io::write_json(
        &staging.join(format!(
            "data/platform/{}-update.json",
            options.environment().name()
        )),
        &json!({"status":"ready","commit":commit,"digest":manifest.digest}),
    )?;
    journal.commit = commit.clone();
    journal.digest = manifest.digest;
    journal.inventory = transaction::snapshot(&staging, &journal.placements())?;
    journal.prepared = true;
    journal.write()?;
    Ok(journal)
}
