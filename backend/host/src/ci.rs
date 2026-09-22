//! Artifact promotion uses the planner's policy and the host's existing verifier.
use crate::{Result, artifact, io::System, releases, require};
use dispatch_ci::policy::{Context, Environment, Policy, Validation, trusted_branch};
use std::{fs, io::Write, os::unix::fs::PermissionsExt, path::Path};

struct Runner<'a>(&'a dyn System);
impl dispatch_ci::Runner for Runner<'_> {
    fn command(&self, args: &[&str], cwd: Option<&Path>, timeout: u64) -> Result<Vec<u8>> {
        self.0.command(args, cwd, timeout, None)
    }
}
#[derive(Debug)]
struct ValidationChanged(&'static str);
impl std::fmt::Display for ValidationChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for ValidationChanged {}
fn require_validation(
    policy: &Policy<'_>,
    context: &Context,
    env: &Environment,
) -> Result<Validation> {
    if context.commit != env.get("GITHUB_SHA") || env.get("GITHUB_EVENT_NAME") != "push" {
        return Err(Box::new(ValidationChanged(
            "Actual trusted merged commit required",
        )));
    }
    let branch = trusted_branch(env.get("GITHUB_REF"))
        .ok_or(ValidationChanged("Trusted branch required"))?;
    match policy.validated(context, branch) {
        Ok(Some(validation)) => Ok(validation),
        _ => Err(Box::new(ValidationChanged(
            "Cannot confirm current PR validation; rerun the workflow",
        ))),
    }
}
fn warm_cache(
    system: &dyn System,
    root: &Path,
    candidate: &Path,
    receipt: &serde_json::Value,
) -> Result<()> {
    let Some(expected) = receipt["rustKey"]
        .as_str()
        .filter(|key| artifact::hex(key, 64))
    else {
        return Ok(());
    };
    // Cargo's bootstrap helper owns compiler/input fingerprints. Rust owns the
    // promotion decision: a verified binary can only seed its original input key.
    let bytes = system.command(
        &[
            "python3",
            "tooling/cargo-build.py",
            "--release",
            "--cache-key",
        ],
        Some(root),
        30,
        None,
    )?;
    let key = String::from_utf8(bytes)?;
    if key.trim() != format!("key={expected}") {
        return Ok(());
    }
    let cache = root.join(".ci-rust-cache");
    fs::create_dir_all(&cache)?;
    artifact::real_directory(&cache)?;
    let entry = cache.join(expected);
    fs::create_dir_all(&entry)?;
    artifact::real_directory(&entry)?;
    let mut temporary = tempfile::NamedTempFile::new_in(&entry)?;
    let source = candidate.join("services/rust/dispatch-backend");
    std::io::copy(&mut fs::File::open(&source)?, &mut temporary)?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o700))?;
    temporary.persist(entry.join("dispatch-backend"))?;
    fs::write(
        entry.join("sha256"),
        format!("{}\n", artifact::file_hash(&source)?),
    )?;
    Ok(())
}
fn restore(
    system: &dyn System,
    policy: &Policy<'_>,
    env: &Environment,
    destination: &Path,
) -> Result<()> {
    let context = policy
        .context()?
        .ok_or(ValidationChanged("Actual merged commit required"))?;
    let verified = require_validation(policy, &context, env)?;
    let run = &verified.run;
    let receipt = &verified.receipt;
    let id = run["id"].as_u64().ok_or("Invalid run id")?;
    let artifacts = policy.github(&format!("actions/runs/{id}/artifacts"))?;
    let name = format!(
        "dispatch-pr-build-{id}-{}",
        run["run_attempt"].as_u64().unwrap_or(1)
    );
    let matches: Vec<_> = artifacts["artifacts"]
        .as_array()
        .ok_or("Missing artifacts")?
        .iter()
        .filter(|record| record["name"] == name && record["expired"] == false)
        .collect();
    require(matches.len() == 1, "Gated PR build unavailable")?;
    require(
        !destination.exists() && !destination.is_symlink(),
        "Build destination already exists",
    )?;
    let temp = tempfile::Builder::new()
        .prefix("dispatch-pr-build-")
        .tempdir_in(destination.parent().ok_or("Destination parent required")?)?;
    let old = receipt["commit"]
        .as_str()
        .ok_or("Receipt commit required")?;
    releases::download_run(system, matches[0], temp.path(), old, None)?;
    let candidate = temp.path().join("candidate");
    artifact::retarget(&candidate, old, &context.commit)?;
    fs::set_permissions(
        candidate.join("services/rust/dispatch-backend"),
        fs::Permissions::from_mode(0o700),
    )?;
    if require_validation(policy, &context, env)? != verified {
        return Err(Box::new(ValidationChanged(
            "PR validation changed during download; rerun the workflow",
        )));
    }
    warm_cache(system, policy.root, &candidate, receipt)?;
    // No replacement, including a destination created while the artifact downloaded.
    let from = std::ffi::CString::new(candidate.as_os_str().as_encoded_bytes())?;
    let to = std::ffi::CString::new(destination.as_os_str().as_encoded_bytes())?;
    if unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    println!(
        "Reused tested PR build from run {id} for {}",
        context.commit
    );
    Ok(())
}
fn reuse(system: &dyn System, root: &Path, env: &Environment, destination: &Path) -> Result<bool> {
    let runner = Runner(system);
    let policy = Policy {
        root,
        runner: &runner,
    };
    match restore(system, &policy, env, destination) {
        Ok(()) => Ok(true),
        Err(error) if error.is::<ValidationChanged>() => Err(error),
        Err(_) => {
            let context = policy
                .context()?
                .ok_or(ValidationChanged("Actual merged commit required"))?;
            require_validation(&policy, &context, env)?;
            println!("PR build reuse unavailable; validation is current, building normally.");
            Ok(false)
        }
    }
}
pub fn run(args: &[String], system: &dyn System) -> Result<()> {
    let args: Vec<_> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["restore", "--root", root, "--output", destination] => {
            let destination = std::path::absolute(destination)?;
            let reused = reuse(
                system,
                Path::new(root),
                &Environment::current(),
                &destination,
            )?;
            writeln!(
                fs::OpenOptions::new()
                    .append(true)
                    .create(true)
                    .open(std::env::var("GITHUB_OUTPUT")?)?,
                "reused={reused}"
            )?;
        }
        ["verify", archive] => {
            let temp = tempfile::Builder::new()
                .prefix("dispatch-ci-artifact-")
                .tempdir()?;
            let root = temp.path().join("build");
            artifact::unpack(Path::new(archive), &root)?;
            artifact::verify(&root, Some(&std::env::var("GITHUB_SHA")?))?;
            println!("Merged candidate inventory and source commit verified");
        }
        _ => return Err("Unknown CI artifact command".into()),
    }
    Ok(())
}
#[cfg(test)]
mod tests;
