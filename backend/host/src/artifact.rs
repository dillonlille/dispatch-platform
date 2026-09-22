use crate::{MAX_BYTES, Result, require};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};

const REQUIRED: [&str; 3] = [
    "dashboard/index.html",
    "services/rust/dispatch-backend",
    "tooling/build-info.json",
];
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub format: u32,
    pub version: String,
    pub runtime: String,
    pub schema: u32,
    pub files: Vec<Entry>,
    pub digest: String,
}
pub use dispatch_ci::policy::hex;
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn file_hash(file: &Path) -> Result<String> {
    let mut input = File::open(file)?;
    let mut hash = Sha256::new();
    let mut bytes = [0; 65536];
    loop {
        let n = input.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub fn safe_path(name: &str) -> Result<()> {
    require(
        !name.is_empty() && !name.contains(['\\', '\0']),
        "Invalid artifact path",
    )?;
    let parts: Vec<_> = name.split('/').collect();
    require(
        parts.iter().all(|p| !matches!(*p, "" | "." | ".."))
            && matches!(
                parts[0],
                "dashboard" | "services" | "tooling" | "release.json"
            ),
        "Artifact path is outside managed code",
    )
}
pub fn real_directory(path: &Path) -> Result<()> {
    require(
        fs::canonicalize(path)? == std::path::absolute(path)?,
        "Artifact symlink denied",
    )
}
pub fn inventory(root: &Path) -> Result<Vec<Entry>> {
    real_directory(root)?;
    fn visit(root: &Path, directory: &Path, files: &mut Vec<Entry>) -> Result<()> {
        for item in fs::read_dir(directory)? {
            let path = item?.path();
            let info = fs::symlink_metadata(&path)?;
            require(!info.is_symlink(), "Artifact symlink denied")?;
            let name = path
                .strip_prefix(root)?
                .to_str()
                .ok_or("Invalid artifact path")?;
            safe_path(name)?;
            if info.is_dir() {
                visit(root, &path, files)?;
            } else {
                require(
                    info.is_file() && info.nlink() == 1,
                    "Artifact special file/hardlink denied",
                )?;
                if name != "release.json" {
                    files.push(Entry {
                        path: name.into(),
                        sha256: file_hash(&path)?,
                        size: info.len(),
                    });
                }
            }
            require(files.len() <= 50_000, "Artifact has too many files")?;
        }
        Ok(())
    }
    let mut files = vec![];
    visit(root, root, &mut files)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}
fn seal(mut value: Value) -> Result<Value> {
    value
        .as_object_mut()
        .ok_or("Invalid manifest")?
        .shift_remove("digest");
    value["digest"] = json!(hash(&serde_json::to_vec(&value)?));
    Ok(value)
}
pub fn write_manifest(root: &Path, version: &str) -> Result<Manifest> {
    let value = seal(
        json!({"format":3,"version":version,"runtime":"rust","schema":3,"files":inventory(root)?}),
    )?;
    fs::write(
        root.join("release.json"),
        format!("{}\n", serde_json::to_string_pretty(&value)?),
    )?;
    verify(root, None)
}
pub fn verify(root: &Path, commit: Option<&str>) -> Result<Manifest> {
    real_directory(root)?;
    let path = root.join("release.json");
    let info = fs::symlink_metadata(&path)?;
    require(
        info.is_file() && !info.is_symlink() && info.nlink() == 1 && info.len() <= 32 * 1024 * 1024,
        "Invalid release manifest",
    )?;
    let mut value: Value = serde_json::from_slice(&fs::read(path)?)?;
    let manifest: Manifest = serde_json::from_value(value.clone())?;
    require(
        manifest.format == 3 && manifest.schema == 3 && manifest.runtime == "rust",
        "Unsupported artifact format/schema",
    )?;
    require(
        regex::Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$")?
            .is_match(&manifest.version),
        "Invalid artifact version",
    )?;
    value
        .as_object_mut()
        .ok_or("Invalid manifest")?
        .shift_remove("digest");
    require(
        hex(&manifest.digest, 64) && hash(&serde_json::to_vec(&value)?) == manifest.digest,
        "Artifact manifest changed",
    )?;
    let mut files = BTreeMap::new();
    require(
        manifest.files.len() <= 50_000,
        "Artifact has too many files",
    )?;
    for entry in &manifest.files {
        safe_path(&entry.path)?;
        require(hex(&entry.sha256, 64), "Invalid inventory entry")?;
        require(
            entry.path != "release.json" && files.insert(entry.path.as_str(), entry).is_none(),
            "Duplicate inventory entry",
        )?;
    }
    let actual = inventory(root)?;
    for entry in &actual {
        require(
            files
                .get(entry.path.as_str())
                .is_some_and(|stored| **stored == *entry),
            "Artifact file verification failed",
        )?;
        require(
            entry.path.starts_with("dashboard/") || REQUIRED[1..].contains(&entry.path.as_str()),
            "Rust-only artifact contains retired runtime files",
        )?;
    }
    require(
        actual.len() == files.len() && REQUIRED.iter().all(|name| files.contains_key(name)),
        "Artifact incomplete or contains extra files",
    )?;
    let metadata: Value = serde_json::from_slice(&fs::read(root.join("tooling/build-info.json"))?)?;
    let source = metadata["commit"].as_str().unwrap_or("");
    require(hex(source, 40), "Invalid build commit")?;
    require(
        commit.is_none_or(|expected| expected == source),
        "Artifact belongs to another commit",
    )?;
    Ok(manifest)
}
pub fn retarget(root: &Path, old: &str, new: &str) -> Result<Manifest> {
    verify(root, Some(old))?;
    require(hex(new, 40), "Invalid build commit")?;
    let path = root.join("tooling/build-info.json");
    let mut metadata: Value = serde_json::from_slice(&fs::read(&path)?)?;
    metadata["commit"] = json!(new);
    fs::write(&path, format!("{metadata}\n"))?;
    // Preserve the order of the original manifest, including inventory entries.
    let mut value: Value = serde_json::from_slice(&fs::read(root.join("release.json"))?)?;
    for entry in value["files"].as_array_mut().ok_or("Invalid inventory")? {
        if entry["path"] == "tooling/build-info.json" {
            entry["sha256"] = json!(file_hash(&path)?);
            entry["size"] = json!(path.metadata()?.len());
        }
    }
    fs::write(root.join("release.json"), format!("{}\n", seal(value)?))?;
    verify(root, Some(new))
}
pub fn unpack(archive: &Path, destination: &Path) -> Result<()> {
    crate::io::private_directory(destination)?;
    real_directory(destination)?;
    require(
        fs::read_dir(destination)?.next().is_none(),
        "Extraction destination must be empty",
    )?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(File::open(archive)?));
    let (mut seen, mut total) = (HashSet::new(), 0u64);
    for entry in archive.entries()? {
        let mut entry = entry?;
        if let Some(extensions) = entry.pax_extensions()? {
            for extension in extensions {
                require(
                    !extension?.key_bytes().starts_with(b"GNU.sparse."),
                    "Artifact links/special files denied",
                )?;
            }
        }
        let bytes = entry.path_bytes();
        let original = std::str::from_utf8(&bytes)?;
        let kind = entry.header().entry_type();
        if matches!(original, "." | "./") && kind.is_dir() {
            continue;
        }
        let name = original.strip_prefix("./").unwrap_or(original);
        let name = if kind.is_dir() {
            name.trim_end_matches('/')
        } else {
            name
        }
        .to_owned();
        safe_path(&name)?;
        require(seen.insert(name.clone()), "Duplicate artifact entry")?;
        require(seen.len() <= 50_000, "Artifact has too many files")?;
        let target = destination.join(&name);
        if kind.is_dir() {
            crate::io::private_directory(&target)?;
        } else {
            require(
                kind.is_file() && !kind.is_gnu_sparse(),
                "Artifact links/special files denied",
            )?;
            let size = entry.size();
            total = total.checked_add(size).ok_or("Artifact is too large")?;
            require(total <= MAX_BYTES, "Artifact is too large")?;
            crate::io::private_directory(target.parent().ok_or("Invalid artifact path")?)?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&target)?;
            require(
                std::io::copy(&mut entry, &mut output)? == size,
                "Truncated artifact entry",
            )?;
            output.flush()?;
            fs::set_permissions(target, fs::Permissions::from_mode(0o600))?;
        }
    }
    Ok(())
}
pub fn unpack_actions(
    download: &Path,
    expected_size: u64,
    expected_digest: &str,
    directory: &Path,
    package: &Path,
    commit: &str,
) -> Result<Manifest> {
    require(
        expected_size > 0 && expected_size <= MAX_BYTES,
        "Invalid artifact size",
    )?;
    require(
        download.metadata()?.len() == expected_size
            && format!("sha256:{}", file_hash(download)?) == expected_digest,
        "GitHub artifact digest mismatch",
    )?;
    let mut zip = zip::ZipArchive::new(File::open(download)?)?;
    require(zip.len() == 1, "Unexpected artifact package")?;
    let entry = zip.by_index(0)?;
    require(
        entry.name() == "dispatch-dev.tar.gz",
        "Unexpected artifact package",
    )?;
    let size = entry.size();
    require(size <= MAX_BYTES, "Package is too large")?;
    let mut out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(package)?;
    require(
        std::io::copy(&mut entry.take(MAX_BYTES + 1), &mut out)? == size,
        "Package is too large or truncated",
    )?;
    out.flush()?;
    unpack(package, &directory.join("candidate"))?;
    verify(&directory.join("candidate"), Some(commit))
}
