use crate::{
    Result, artifact, io, require,
    updater::{Environment, Updater},
};
use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::PermissionsExt,
    path::Path,
};

pub fn directory(updater: &Updater<'_>) -> std::path::PathBuf {
    updater
        .root
        .join(if updater.environment == Environment::Dev {
            ".runtime/management"
        } else {
            "management"
        })
}
pub fn supported(root: &Path) -> Result<bool> {
    Ok(io::read_json(&root.join("tooling/build-info.json"))?["hostManagement"] == 1)
}
pub fn drift(updater: &Updater<'_>) -> Result<bool> {
    if !supported(&updater.active)? {
        return Ok(false);
    }
    let installed = directory(updater).join("dispatch-host");
    Ok(!installed.is_file()
        || installed.is_symlink()
        || artifact::file_hash(&installed)?
            != artifact::file_hash(&updater.active.join("services/rust/dispatch-backend"))?)
}
pub fn install(updater: &Updater<'_>) -> Result<()> {
    let manifest = updater.verify()?;
    require(
        supported(&updater.active)?,
        "Active runtime has no Rust host management; install from a verified supporting release",
    )?;
    let directory = directory(updater);
    io::private_directory(&directory)?;
    copy_verified(updater.system, &updater.active, &directory, &manifest)
}
pub(super) fn copy_verified(
    system: &dyn io::System,
    active: &Path,
    directory: &Path,
    manifest: &artifact::Manifest,
) -> Result<()> {
    io::private_directory(directory)?;
    let source = active.join("services/rust/dispatch-backend");
    let mut staged = tempfile::NamedTempFile::new_in(directory)?;
    let mut input = fs::File::open(&source)?;
    let mut bytes = [0; 65536];
    loop {
        let n = input.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        staged.write_all(&bytes[..n])?;
    }
    staged
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o700))?;
    staged.as_file().sync_all()?;
    require(
        artifact::file_hash(staged.path())?
            == manifest
                .files
                .iter()
                .find(|entry| entry.path == "services/rust/dispatch-backend")
                .ok_or("Missing host executable")?
                .sha256,
        "Host management copy changed",
    )?;
    // Close the writable descriptor before executing the staged copy (ETXTBSY).
    let staged = staged.into_temp_path();
    let capabilities: Value = serde_json::from_slice(&system.command(
        &[
            staged.to_str().ok_or("Invalid management path")?,
            "host",
            "capabilities",
        ],
        None,
        30,
        None,
    )?)?;
    require(
        capabilities["hostManagement"] == 1,
        "Host updater does not start",
    )?;
    staged.persist(directory.join("dispatch-host"))?;
    fs::File::open(directory)?.sync_all()?;
    Ok(())
}
pub fn refresh(updater: &Updater<'_>) -> Result<()> {
    if !supported(&updater.active)? || !drift(updater)? {
        return Ok(());
    }
    // A failed updater self-check must not replace the one performing recovery.
    if let Err(error) = install(updater) {
        eprintln!("Host updater was not installed: {error}");
    }
    Ok(())
}

const RUNTIME_LAUNCHER: &[u8] = include_bytes!("../../../tooling/runtime_artifact.py");
const DEV_LAUNCHER: &[u8] = include_bytes!("../../../tooling/update-dev.py");
const PRODUCTION_LAUNCHER: &[u8] = include_bytes!("../../../tooling/update-production.py");

/// Prepare all three installation files before exposing any of them to a unit.
pub(super) fn prepare_bundle(
    system: &dyn io::System,
    active: &Path,
    target: &Path,
    environment: Environment,
    manifest: &artifact::Manifest,
) -> Result<()> {
    copy_verified(system, active, target, manifest)?;
    for (name, bytes) in [
        ("runtime_artifact.py", RUNTIME_LAUNCHER),
        (
            if environment == Environment::Dev {
                "update-dev.py"
            } else {
                "update-production.py"
            },
            if environment == Environment::Dev {
                DEV_LAUNCHER
            } else {
                PRODUCTION_LAUNCHER
            },
        ),
    ] {
        let mut temp = tempfile::NamedTempFile::new_in(target)?;
        temp.write_all(bytes)?;
        temp.as_file().sync_all()?;
        temp.persist(target.join(name))?;
    }
    fs::File::open(target)?.sync_all()?;
    Ok(())
}
/// Explicit installation also refreshes compatibility launchers as one directory.
/// Automatic Dev refresh retains its established binary-only behavior.
pub fn install_bundle(updater: &Updater<'_>) -> Result<()> {
    // Exclude activation while binding the copied manager to the active runtime.
    let _lock = crate::io::ExclusiveLock::acquire(
        &updater
            .platform
            .join(format!("{}-update.lock", updater.environment.name())),
    )?;
    let manifest = updater.verify()?;
    require(
        supported(&updater.active)?,
        "Active runtime has no Rust host management",
    )?;
    let target = directory(updater);
    let temp = tempfile::Builder::new()
        .prefix(".management-install-")
        .tempdir_in(&updater.runtime)?;
    let staged = temp.path().join("management");
    prepare_bundle(
        updater.system,
        &updater.active,
        &staged,
        updater.environment,
        &manifest,
    )?;
    require(
        !target.is_symlink(),
        "Management directory cannot be a symlink",
    )?;
    if target.exists() {
        artifact::real_directory(&target)?;
        let retained = temp.keep();
        rename(&staged, &target, libc::RENAME_EXCHANGE)?;
        fs::rename(&staged, retained.join("previous-management"))?;
        fs::File::open(&retained)?.sync_all()?;
        eprintln!("Previous manager retained in {}", retained.display());
    } else {
        rename(&staged, &target, libc::RENAME_NOREPLACE)?;
    }
    fs::File::open(target.parent().ok_or("Management parent required")?)?.sync_all()?;
    Ok(())
}
pub(super) fn rename(from: &Path, to: &Path, flags: libc::c_uint) -> Result<()> {
    let from = std::ffi::CString::new(from.as_os_str().as_encoded_bytes())?;
    let to = std::ffi::CString::new(to.as_os_str().as_encoded_bytes())?;
    if unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            flags,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
