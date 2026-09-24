use crate::{
    MAX_BYTES, REPOSITORY, Result, artifact,
    io::{self, System},
    require,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

pub use dispatch_ci::runs::{latest_run, passed};
pub fn download_run(
    system: &dyn System,
    record: &Value,
    directory: &Path,
    commit: &str,
    package: Option<&Path>,
) -> Result<artifact::Manifest> {
    let size = record["size_in_bytes"].as_u64().unwrap_or(0);
    require(size > 0 && size <= MAX_BYTES, "Invalid artifact size")?;
    let id = record["id"].as_u64().ok_or("Invalid artifact id")?;
    let download = directory.join("artifact.zip");
    system.command(
        &[
            "gh",
            "api",
            &format!("repos/{REPOSITORY}/actions/artifacts/{id}/zip"),
        ],
        None,
        180,
        Some(&download),
    )?;
    artifact::unpack_actions(
        &download,
        size,
        record["digest"].as_str().unwrap_or(""),
        directory,
        package.unwrap_or(&directory.join("build.tar.gz")),
        commit,
    )
}
pub fn version(value: &str) -> Result<Vec<u64>> {
    require(
        regex::Regex::new(r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$")?
            .is_match(value),
        "Stable semantic version required",
    )?;
    Ok(value
        .split('.')
        .map(str::parse)
        .collect::<std::result::Result<_, _>>()?)
}
pub fn release_version(release: &Value) -> Result<String> {
    require(
        release["draft"] == false
            && release["prerelease"] == false
            && release["published_at"]
                .as_str()
                .is_some_and(|s| !s.is_empty()),
        "Published stable release required",
    )?;
    let tag = release["tag_name"].as_str().unwrap_or("");
    let value = tag.strip_prefix('v').ok_or("Version tag required")?;
    version(value)?;
    Ok(value.into())
}
pub fn public_github(system: &dyn System, endpoint: &str) -> Result<Value> {
    io::json_response(system.request(
        &format!("https://api.github.com/repos/{REPOSITORY}/{endpoint}"),
        false,
        true,
        30,
    )?)
}
pub fn latest_tag(system: &dyn System) -> Option<String> {
    let mut url = format!("https://github.com/{REPOSITORY}/releases/latest");
    // A moved repository first redirects to the same page under its new name.
    for _ in 0..2 {
        let response = system.request(&url, true, false, 15).ok()?;
        let location = response.location?;
        let path = crate::web_path(&location)?;
        match response.status {
            302 => return path.strip_prefix("releases/tag/").map(str::to_owned),
            301 | 307 | 308 if path == "releases/latest" => url = location,
            _ => return None,
        }
    }
    None
}
pub fn release_commit(system: &dyn System, tag: &str) -> Result<String> {
    require(tag.starts_with('v'), "Version tag required")?;
    version(&tag[1..])?;
    let mut object = public_github(system, &format!("git/ref/tags/{tag}"))?["object"].clone();
    for _ in 0..5 {
        if object["type"] == "commit" {
            break;
        }
        let sha = object["sha"].as_str().unwrap_or("");
        require(
            object["type"] == "tag" && artifact::hex(sha, 40),
            "Invalid tag",
        )?;
        object = public_github(system, &format!("git/tags/{sha}"))?["object"].clone();
    }
    let commit = io::text(&object, "sha");
    require(
        object["type"] == "commit" && artifact::hex(&commit, 40),
        "Invalid tag commit",
    )?;
    let comparison = public_github(system, &format!("compare/{commit}...main"))?;
    require(
        matches!(comparison["status"].as_str(), Some("ahead" | "identical")),
        "Release is not part of main",
    )?;
    Ok(commit)
}
pub fn download_asset(
    system: &dyn System,
    release: &Value,
    name: &str,
    target: &Path,
) -> Result<()> {
    let assets: Vec<_> = release["assets"]
        .as_array()
        .ok_or("Missing release assets")?
        .iter()
        .filter(|a| a["name"] == name && a["state"] == "uploaded")
        .collect();
    require(assets.len() == 1, "Release asset missing or duplicated")?;
    let asset = assets[0];
    let size = asset["size"].as_u64().unwrap_or(0);
    require(size > 0 && size <= MAX_BYTES, "Invalid release asset size")?;
    // The URL GitHub reports, under any of this repository's names, for exactly this asset.
    let url = io::text(asset, "browser_download_url");
    require(
        crate::web_path(&url)
            == Some(&format!(
                "releases/download/{}/{name}",
                io::text(release, "tag_name")
            )),
        "Unexpected release asset URL",
    )?;
    let expected = io::text(asset, "digest");
    require(
        expected
            .strip_prefix("sha256:")
            .is_some_and(|h| artifact::hex(h, 64)),
        "GitHub asset digest required",
    )?;
    let mut response = system.request(&url, false, true, 60)?;
    require(response.status == 200, "Release download failed")?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(target)?;
    let (mut digest, mut total) = (Sha256::new(), 0u64);
    let mut bytes = [0; 65536];
    loop {
        let n = response.body.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        require(total <= size, "Download exceeds declared size")?;
        digest.update(&bytes[..n]);
        output.write_all(&bytes[..n])?;
    }
    require(
        total == size && format!("sha256:{}", crate::to_hex(&digest.finalize())) == expected,
        "GitHub asset digest mismatch",
    )
}
