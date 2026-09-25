//! Exact-input backend cache. Schema 3 deliberately cannot reuse Python-era keys.
mod key;
mod store;
#[cfg(test)]
mod tests;
use crate::{Result, Runner, require};
pub use key::{Environment, eligible, fingerprint, key};
use std::{fs, path::Path};

pub fn ci_enabled(root: &Path, env: &Environment) -> bool {
    env.get("CI").is_some_and(|v| v == "true")
        && env
            .get("DISPATCH_CI_RUST_CACHE")
            .is_some_and(|v| Path::new(v) == root.join(".ci-rust-cache"))
}
pub fn build(root: &Path, release: bool, env: &Environment, runner: &dyn Runner) -> Result<()> {
    build_with_limit(root, release, env, runner, 8)
}
fn build_with_limit(
    root: &Path,
    release: bool,
    env: &Environment,
    runner: &dyn Runner,
    keep: usize,
) -> Result<()> {
    let profile = if release { "release" } else { "debug" };
    let args: &[&str] = if release {
        &["cargo", "build", "--locked", "--release"]
    } else {
        &["cargo", "build", "--locked"]
    };
    let ci = release && ci_enabled(root, env);
    if !eligible(root, env, ci)? {
        println!("Building {profile} backend with Cargo.");
        runner.command(args, Some(root), 1200)?;
        return Ok(());
    }
    let compiler = key::compiler(root, runner)?;
    let key = fingerprint(root, profile, &compiler, env)?;
    require(
        !ci || env
            .get("DISPATCH_CI_RUST_KEY")
            .is_none_or(|expected| expected == &key),
        "CI Rust inputs changed after cache selection",
    )?;
    let cache = if ci {
        root.join(".ci-rust-cache")
    } else {
        let common = runner.command(
            &[
                "git",
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
            ],
            Some(root),
            30,
        )?;
        Path::new(std::str::from_utf8(&common)?.trim()).join("dispatch-rust-builds")
    };
    store::directory(&cache)?;
    let entry = cache.join(&key);
    let target = root.join("target").join(profile).join("dispatch-backend");
    let _lock = store::Lock::acquire(&cache, &key, true)?.ok_or("Cache lock unavailable")?;
    if let Some(binary) = store::cached_binary(&entry) {
        store::copy_binary(&binary, &target)?;
        println!("Reused {profile} backend for identical Rust inputs.");
    } else {
        println!("Building {profile} backend with Cargo.");
        runner.command(args, Some(root), 1200)?;
        require(
            fingerprint(root, profile, &compiler, env)? == key,
            "Rust inputs changed during the build; run it again before packaging",
        )?;
        store::save(&entry, &target)?;
        println!("Cached {profile} backend for identical inputs.");
    }
    if !ci {
        fs::File::open(&entry)?
            .set_times(fs::FileTimes::new().set_modified(std::time::SystemTime::now()))?;
        store::prune(&cache, keep, &key)?;
    }
    Ok(())
}
/// Called only after the host verifier has accepted the promoted artifact.
pub fn seed(
    root: &Path,
    source: &Path,
    expected: &str,
    env: &Environment,
    runner: &dyn Runner,
) -> Result<()> {
    if !crate::hex(expected, 64)
        || !eligible(root, env, true)?
        || key(root, "release", env, runner)? != expected
    {
        return Ok(());
    }
    let cache = root.join(".ci-rust-cache");
    store::directory(&cache)?;
    let _lock = store::Lock::acquire(&cache, expected, true)?.ok_or("Cache lock unavailable")?;
    store::save(&cache.join(expected), source)
}
