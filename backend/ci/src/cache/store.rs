use crate::{Result, hex, require};
use fs2::FileExt;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
pub(super) fn directory(path: &Path) -> Result<()> {
    require(!path.is_symlink(), "Cache directory cannot be a symlink")?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    Ok(())
}
pub(super) fn hash(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(crate::to_hex(&digest.finalize()))
}
pub(super) fn copy_binary(source: &Path, destination: &Path) -> Result<()> {
    let parent = destination
        .parent()
        .ok_or("Binary destination parent required")?;
    directory(parent)?;
    require(
        source.is_file() && !source.is_symlink(),
        "Regular source binary required",
    )?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    std::io::copy(&mut File::open(source)?, &mut temp)?;
    temp.as_file()
        .set_permissions(fs::Permissions::from_mode(0o700))?;
    temp.as_file().sync_all()?;
    temp.persist(destination)?;
    Ok(())
}
pub(super) fn cached_binary(entry: &Path) -> Option<PathBuf> {
    if entry.is_symlink() {
        return None;
    }
    let binary = entry.join("dispatch-backend");
    let receipt = entry.join("sha256");
    if binary.is_symlink() || receipt.is_symlink() {
        return None;
    }
    let expected = fs::read_to_string(receipt).ok()?;
    (hex(expected.trim(), 64) && hash(&binary).ok()? == expected.trim()).then_some(binary)
}
pub(super) fn save(entry: &Path, source: &Path) -> Result<()> {
    directory(entry)?;
    let binary = entry.join("dispatch-backend");
    copy_binary(source, &binary)?;
    let mut receipt = tempfile::NamedTempFile::new_in(entry)?;
    writeln!(receipt, "{}", hash(&binary)?)?;
    receipt.as_file().sync_all()?;
    receipt.persist(entry.join("sha256"))?;
    File::open(entry)?.sync_all()?;
    Ok(())
}
pub(super) struct Lock(File);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}
impl Lock {
    pub(super) fn acquire(cache: &Path, key: &str, wait: bool) -> Result<Option<Self>> {
        require(hex(key, 64), "Invalid cache key")?;
        let path = cache.join(format!("{key}.lock"));
        loop {
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&path)?;
            if wait {
                file.lock_exclusive()?;
            } else if let Err(error) = file.try_lock_exclusive() {
                if error.kind() == std::io::ErrorKind::WouldBlock {
                    return Ok(None);
                }
                return Err(error.into());
            }
            let guard = Self(file);
            let held = guard.0.metadata()?;
            if fs::metadata(&path)
                .is_ok_and(|current| current.ino() == held.ino() && current.dev() == held.dev())
            {
                return Ok(Some(guard));
            }
        }
    }
}
pub(super) fn stale_entries(cache: &Path, keep: usize, protect: &str) -> Result<Vec<String>> {
    let mut used: BTreeMap<String, SystemTime> = BTreeMap::new();
    for entry in fs::read_dir(cache)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(info) = entry.path().symlink_metadata() else {
            continue;
        };
        if info.is_dir() && hex(&name, 64) {
            used.insert(name, info.modified()?);
        } else if info.is_file()
            && let Some(key) = name.strip_suffix(".lock").filter(|key| hex(key, 64))
        {
            used.entry(key.into()).or_insert(UNIX_EPOCH);
        }
    }
    used.remove(protect);
    let mut entries: Vec<_> = used.into_iter().collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.cmp(&a.0)));
    Ok(entries
        .into_iter()
        .skip(keep.saturating_sub(1))
        .map(|(key, _)| key)
        .collect())
}
pub(super) fn prune(cache: &Path, keep: usize, protect: &str) -> Result<()> {
    for key in stale_entries(cache, keep, protect)? {
        let Ok(Some(_lock)) = Lock::acquire(cache, &key, false) else {
            continue;
        };
        let _ = fs::remove_dir_all(cache.join(&key));
        match fs::remove_file(cache.join(format!("{key}.lock"))) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
