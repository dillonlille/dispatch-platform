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
    let source = updater.active.join("services/rust/dispatch-backend");
    let mut staged = tempfile::NamedTempFile::new_in(&directory)?;
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
    let capabilities: Value = serde_json::from_slice(&updater.system.command(
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
    fs::File::open(&directory)?.sync_all()?;
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
