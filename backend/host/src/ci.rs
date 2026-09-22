//! Artifact promotion uses the planner's policy and the host's existing verifier.
use crate::{Result, artifact, io::System, releases, require};
use dispatch_ci::policy::{Context, Environment, Policy, Validation, trusted_branch};
use serde_json::Value;
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
/// Whether this run validates a PR merge or merge queue group into dev.
fn into_dev(env: &Environment) -> bool {
    match env.get("GITHUB_EVENT_NAME") {
        "pull_request" => env.get("GITHUB_BASE_REF") == "dev",
        "merge_group" => env
            .get("GITHUB_REF")
            .starts_with("refs/heads/gh-readonly-queue/dev/"),
        _ => false,
    }
}
/// Main's passed push run when this merge into dev brings exactly main's tree: main already
/// validated it in full and published it, so its build is reused and only smoke tested.
fn require_main(policy: &Policy<'_>, context: &Context, env: &Environment) -> Result<Value> {
    if context.commit != env.get("GITHUB_SHA") || !into_dev(env) {
        return Err(Box::new(ValidationChanged(
            "Actual PR merge into dev required",
        )));
    }
    match policy.brings_main(context) {
        Ok(Some(run)) => Ok(run),
        _ => Err(Box::new(ValidationChanged(
            "Cannot confirm main's validation of the PR head; rerun the workflow",
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
fn restore_main(
    system: &dyn System,
    policy: &Policy<'_>,
    env: &Environment,
    destination: &Path,
) -> Result<()> {
    let context = policy
        .context()?
        .ok_or(ValidationChanged("Actual PR merge required"))?;
    let run = require_main(policy, &context, env)?;
    let id = run["id"].as_u64().ok_or("Invalid run id")?;
    let artifacts = policy.github(&format!("actions/runs/{id}/artifacts"))?;
    let name = format!("dispatch-main-{}", context.head);
    let matches: Vec<_> = artifacts["artifacts"]
        .as_array()
        .ok_or("Missing artifacts")?
        .iter()
        .filter(|record| record["name"] == name && record["expired"] == false)
        .collect();
    require(matches.len() == 1, "Published main build unavailable")?;
    require(
        !destination.exists() && !destination.is_symlink(),
        "Build destination already exists",
    )?;
    let temp = tempfile::Builder::new()
        .prefix("dispatch-main-build-")
        .tempdir_in(destination.parent().ok_or("Destination parent required")?)?;
    releases::download_run(system, matches[0], temp.path(), &context.head, None)?;
    let candidate = temp.path().join("candidate");
    artifact::retarget(&candidate, &context.head, &context.commit)?;
    fs::set_permissions(
        candidate.join("services/rust/dispatch-backend"),
        fs::Permissions::from_mode(0o700),
    )?;
    if require_main(policy, &context, env)? != run {
        return Err(Box::new(ValidationChanged(
            "Main's validation changed during download; rerun the workflow",
        )));
    }
    place(&candidate, destination)?;
    println!(
        "Reused main's published build from run {id} for {}",
        context.commit
    );
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
    place(&candidate, destination)?;
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
    let pull = into_dev(env);
    let result = if pull {
        restore_main(system, &policy, env, destination)
    } else {
        restore(system, &policy, env, destination)
    };
    match result {
        Ok(()) => Ok(true),
        Err(error) if error.is::<ValidationChanged>() => Err(error),
        Err(_) => {
            let context = policy
                .context()?
                .ok_or(ValidationChanged("Actual merged commit required"))?;
            if pull {
                require_main(&policy, &context, env)?;
            } else {
                require_validation(&policy, &context, env)?;
            }
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
