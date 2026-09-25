use crate::{Result, Runner};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};
pub type Environment = BTreeMap<String, String>;
// The host embeds these compatibility launchers for fresh management installs.
const INPUTS: &[&str] = &[
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "rust-toolchain",
    "tooling/cargo-build.py",
    "tooling/rustc-remap.py",
    "tooling/ci_tool.py",
    "tooling/runtime_artifact.py",
    "tooling/update-dev.py",
    "tooling/update-production.py",
];
fn walk(root: &Path, files: &mut BTreeSet<PathBuf>) -> Result<()> {
    if !root.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        if path.is_symlink() || !path.is_dir() {
            files.insert(path);
        } else {
            walk(&path, files)?;
        }
    }
    Ok(())
}
fn configs(root: &Path, env: &Environment) -> Result<Vec<PathBuf>> {
    let home = match env.get("CARGO_HOME") {
        Some(home) => PathBuf::from(home),
        None => PathBuf::from(env.get("HOME").ok_or("HOME or CARGO_HOME required")?).join(".cargo"),
    };
    Ok(root
        .ancestors()
        .map(|p| p.join(".cargo"))
        .chain([home])
        .flat_map(|p| [p.join("config"), p.join("config.toml")])
        .collect())
}
fn flags(env: &Environment) -> Environment {
    env.iter()
        .filter(|(key, _)| {
            ["CARGO_", "RUST", "CC_", "CXX_", "PKG_CONFIG"]
                .iter()
                .any(|prefix| key.starts_with(prefix))
                || [
                    "CC",
                    "CXX",
                    "CFLAGS",
                    "CPPFLAGS",
                    "CXXFLAGS",
                    "LDFLAGS",
                    "AR",
                    "RANLIB",
                    // The distribution, not the weekly image build: the compiler, C compiler and
                    // linker versions that image updates can change are fingerprinted directly.
                    "ImageOS",
                    "RUNNER_OS",
                    "RUNNER_ARCH",
                ]
                .contains(&key.as_str())
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}
pub fn fingerprint(
    root: &Path,
    profile: &str,
    compiler: &str,
    env: &Environment,
) -> Result<String> {
    let mut digest = Sha256::new();
    digest.update(serde_json::to_vec(&(
        4,
        profile,
        compiler,
        std::env::consts::OS,
        std::env::consts::ARCH,
        flags(env),
    ))?);
    let mut files: BTreeSet<_> = INPUTS.iter().map(|name| root.join(name)).collect();
    walk(&root.join("backend"), &mut files)?;
    walk(&root.join(".cargo"), &mut files)?;
    files.extend(configs(root, env)?);
    for file in files {
        if file.is_file() {
            let name = file
                .strip_prefix(root)
                .unwrap_or(&file)
                .to_str()
                .ok_or("Non-UTF8 Rust input path")?;
            digest.update(name.as_bytes());
            digest.update([0]);
            digest.update(fs::read(&file)?);
            digest.update([0]);
        }
    }
    Ok(crate::to_hex(&digest.finalize()))
}
fn normalized(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            other => result.push(other.as_os_str()),
        }
    }
    result
}
fn external(value: &toml::Value, manifest: &Path, backend: &Path) -> bool {
    match value {
        toml::Value::Table(values) => values.iter().any(|(key, value)| {
            (key == "path"
                && value.as_str().is_some_and(|path| {
                    let path = manifest.parent().unwrap().join(path);
                    !path
                        .canonicalize()
                        .unwrap_or_else(|_| normalized(&path))
                        .starts_with(backend)
                }))
                || external(value, manifest, backend)
        }),
        toml::Value::Array(values) => values
            .iter()
            .any(|value| external(value, manifest, backend)),
        _ => false,
    }
}
/// Only the repository's exact path-remapping config may use the shared binary cache.
fn remap_config(root: &Path, file: &Path) -> bool {
    let wrapper = root.join("tooling/rustc-remap.py");
    if file != root.join(".cargo/config.toml")
        || file.is_symlink()
        || file.parent().is_some_and(Path::is_symlink)
        || wrapper.is_symlink()
        || wrapper.parent().is_some_and(Path::is_symlink)
    {
        return false;
    }
    let (Ok(bytes), Ok(text)) = (fs::read(wrapper), fs::read_to_string(file)) else {
        return false;
    };
    let hash = crate::to_hex(&Sha256::digest(bytes));
    let expected: toml::Value = toml::from_str(&format!(
        "[build]\nrustc-wrapper = 'tooling/rustc-remap.py'\nrustflags = ['--cfg=dispatch_path_policy_{hash}']\n"
    ))
    .unwrap();
    toml::from_str::<toml::Value>(&text).is_ok_and(|config| config == expected)
}
pub fn eligible(root: &Path, env: &Environment, allow_ci: bool) -> Result<bool> {
    let nonempty = |key: &str| env.get(key).is_some_and(|value| !value.is_empty());
    if (nonempty("CI") && !allow_ci)
        || nonempty("DISPATCH_DISABLE_RUST_CACHE")
        || nonempty("CARGO_TARGET_DIR")
        // These override the policy fingerprint in build.rustflags.
        || nonempty("RUSTFLAGS")
        || nonempty("CARGO_ENCODED_RUSTFLAGS")
        || env.keys().any(|key| {
            key.starts_with("CARGO_SOURCE_")
                || key.starts_with("CARGO_BUILD_")
                || [
                    "RUSTC",
                    "RUSTC_WRAPPER",
                    "RUSTC_WORKSPACE_WRAPPER",
                    "CC",
                    "CXX",
                    "AR",
                    "RANLIB",
                ]
                .contains(&key.as_str())
        })
        || configs(root, env)?
            .iter()
            .any(|p| (p.exists() || p.is_symlink()) && !remap_config(root, p))
    {
        return Ok(false);
    }
    let workspace: toml::Value = toml::from_str(&fs::read_to_string(root.join("Cargo.toml"))?)?;
    let members: Vec<_> = workspace
        .get("workspace")
        .and_then(|v| v.get("members"))
        .and_then(toml::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(toml::Value::as_str)
        .collect();
    if members != ["backend"]
        && members != ["backend", "backend/host"]
        && members != ["backend", "backend/host", "backend/ci"]
    {
        return Ok(false);
    }
    let mut files = BTreeSet::new();
    walk(&root.join("backend"), &mut files)?;
    if files
        .iter()
        .any(|p| p.is_symlink() || p.file_name().is_some_and(|n| n == "build.rs"))
    {
        return Ok(false);
    }
    let backend = root.join("backend");
    for manifest in [root.join("Cargo.toml")].into_iter().chain(
        files
            .into_iter()
            .filter(|p| p.file_name().is_some_and(|n| n == "Cargo.toml")),
    ) {
        let value: toml::Value = toml::from_str(&fs::read_to_string(&manifest)?)?;
        let build = value.get("package").and_then(|v| v.get("build"));
        if build.is_some_and(|v| v.as_bool() != Some(false))
            || external(&value, &manifest, &backend)
        {
            return Ok(false);
        }
    }
    Ok(true)
}
/// The toolchain that shapes the binary: Rust, the C compiler and the linker, by version.
pub(super) fn compiler(root: &Path, runner: &dyn Runner) -> Result<String> {
    Ok(format!(
        "{}\n{}\n{}",
        String::from_utf8(runner.command(&["rustc", "-vV"], Some(root), 30)?)?.trim(),
        String::from_utf8(runner.command(&["cc", "--version"], Some(root), 30)?)?.trim(),
        String::from_utf8(runner.command(&["ld", "--version"], Some(root), 30)?)?.trim()
    ))
}
pub fn key(root: &Path, profile: &str, env: &Environment, runner: &dyn Runner) -> Result<String> {
    fingerprint(root, profile, &compiler(root, runner)?, env)
}
