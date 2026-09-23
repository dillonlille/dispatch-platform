//! Artifact promotion uses the planner's policy and the host's existing verifier.
use crate::{Result, artifact, io::System, releases, require};
use dispatch_ci::policy::{Context, Environment, Policy, Validation, trusted_branch};
use std::{fs, io::Write, os::unix::fs::PermissionsExt, path::Path};

pub(crate) struct Runner<'a>(pub(crate) &'a dyn System);
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
/// Whether this run validates a PR merge or merge queue group into main.
fn into_main(env: &Environment) -> bool {
    match env.get("GITHUB_EVENT_NAME") {
        "pull_request" => env.get("GITHUB_BASE_REF") == "main",
        "merge_group" => {
            env.get("GITHUB_REF")
                .strip_prefix("refs/heads/gh-readonly-queue/")
                .and_then(|rest| rest.split('/').next())
                == Some("main")
        }
        _ => false,
    }
}
/// The PR run whose validation covers the bytes this run may reuse, refusing anything
/// else. Checked again after the download, so validation revoked meanwhile stops the
/// promotion.
fn verified(policy: &Policy<'_>, context: &Context, env: &Environment) -> Result<Validation> {
    if context.commit != env.get("GITHUB_SHA") {
        return Err(Box::new(ValidationChanged("Actual merged commit required")));
    }
    if into_main(env) {
        // A merge queue group that is exactly its PR's merge reuses that PR run's gated build.
        if env.get("GITHUB_EVENT_NAME") == "merge_group"
            && let Ok(Some(validation)) = policy.validated_pull(context, "main")
        {
            return Ok(validation);
        }
        return Err(Box::new(ValidationChanged(
            "Cannot confirm this merge's own PR run; rerun the workflow",
        )));
    }
    if env.get("GITHUB_EVENT_NAME") != "push" {
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
fn place(candidate: &Path, destination: &Path) -> Result<()> {
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
    Ok(())
}
fn warm_cache(
    system: &dyn System,
    root: &Path,
    candidate: &Path,
    receipt: &serde_json::Value,
) -> Result<()> {
    let Some(expected) = receipt["rustKey"].as_str() else {
        return Ok(());
    };
    dispatch_ci::cache::seed(
        root,
        &candidate.join("services/rust/dispatch-backend"),
        expected,
        &std::env::vars().collect(),
        &Runner(system),
    )
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
    let verification = verified(policy, &context, env)?;
    // Each build is named for the run that produced it and carries that run's source commit.
    let id = verification.run["id"].as_u64().ok_or("Invalid run id")?;
    let name = format!(
        "dispatch-pr-build-{id}-{}",
        verification.run["run_attempt"].as_u64().unwrap_or(1)
    );
    let source = verification.receipt["commit"]
        .as_str()
        .ok_or("Receipt commit required")?
        .to_owned();
    let artifacts = policy.github(&format!("actions/runs/{id}/artifacts"))?;
    let matches: Vec<_> = artifacts["artifacts"]
        .as_array()
        .ok_or("Missing artifacts")?
        .iter()
        .filter(|record| record["name"] == name && record["expired"] == false)
        .collect();
    require(matches.len() == 1, "Verified build unavailable")?;
    require(
        !destination.exists() && !destination.is_symlink(),
        "Build destination already exists",
    )?;
    let temp = tempfile::Builder::new()
        .prefix("dispatch-verified-build-")
        .tempdir_in(destination.parent().ok_or("Destination parent required")?)?;
    releases::download_run(system, matches[0], temp.path(), &source, None)?;
    let candidate = temp.path().join("candidate");
    artifact::retarget(&candidate, &source, &context.commit)?;
    fs::set_permissions(
        candidate.join("services/rust/dispatch-backend"),
        fs::Permissions::from_mode(0o700),
    )?;
    if verified(policy, &context, env)? != verification {
        return Err(Box::new(ValidationChanged(
            "Validation changed during download; rerun the workflow",
        )));
    }
    warm_cache(system, policy.root, &candidate, &verification.receipt)?;
    place(&candidate, destination)?;
    println!(
        "Reused the verified build from run {id} for {}",
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
            verified(&policy, &context, env)?;
            println!("Verified build unavailable; validation is current, building normally.");
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
